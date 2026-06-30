// audit 2026-05-22 MC-20 / Tema 8 — chains.ts god-module split (2/3): rpc-utils.
// Retry/quorum wrapper'ları + head barrier + transient error filter burada.
// transport.ts'ten arcClient + arcReadClients import edip üzerine bina kurar.
// arcClient.readContract bu modül yüklendiğinde monkey-patch'lenir (eski
// chains.ts davranışıyla aynı; barrel ./chains.js export'u side-effect garantili).
import type { PublicClient } from "viem";
import { arcClient, arcReadClients, READ_URLS } from "./transport.js";

const QUORUM_K = Number(process.env.ARC_MCP_QUORUM_K ?? Math.min(2, arcReadClients.length));
const QUORUM_ATTEMPTS = Number(process.env.ARC_MCP_QUORUM_ATTEMPTS ?? 8);
const QUORUM_BACKOFF_BASE_MS = Number(process.env.ARC_MCP_QUORUM_BACKOFF_BASE_MS ?? 250);
const QUORUM_BACKOFF_MAX_MS = Number(process.env.ARC_MCP_QUORUM_BACKOFF_MAX_MS ?? 4000);
const HEAD_WAIT_TIMEOUT_MS = Number(process.env.ARC_MCP_HEAD_WAIT_TIMEOUT_MS ?? 30_000);
const HEAD_WAIT_POLL_MS = Number(process.env.ARC_MCP_HEAD_WAIT_POLL_MS ?? 500);

// 2026-05-14 Codex handoff — Arc okuma planı flaky. `readContract` çağrıları
// timeout/429/5xx/network glitch yiyince MCP tool çağrısı fatal görünüyor ama
// tx aslında zincirde başarılı (Gemini HAND 4 `readContract(getSeat)` river
// betting'te birden fazla transient hata verdi, retry path kurtardı).
// Burada `arcClient.readContract`'ı exponential backoff'lu wrapper ile sar:
//   - max attempts ARC_MCP_READ_RETRY_MAX_ATTEMPTS (default 8)
//   - base delay ARC_MCP_READ_RETRY_BASE_DELAY_MS (default 500ms)
//   - max delay ARC_MCP_READ_RETRY_MAX_DELAY_MS (default 10s)
// Daily quota / hard rate-limit retry edilmez — provider failover ihtiyacı.
const rawReadContract = arcClient.readContract.bind(arcClient);
const READ_RETRY_MAX_ATTEMPTS = Number(process.env.ARC_MCP_READ_RETRY_MAX_ATTEMPTS ?? 8);
const READ_RETRY_BASE_DELAY_MS = Number(process.env.ARC_MCP_READ_RETRY_BASE_DELAY_MS ?? 500);
const READ_RETRY_MAX_DELAY_MS = Number(process.env.ARC_MCP_READ_RETRY_MAX_DELAY_MS ?? 10_000);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableReadError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  if (/daily request limit reached/i.test(message)) return false;
  // 2026-05-20 — "GRPC Context cancellation" / "context deadline" are dRPC
  // load-balancer transient cancellations (seen under burst load); retryable.
  // 2026-05-25 — Codex P1 audit parity with agent-runner arc-tx.ts
  // READ_RETRY_TRANSIENT_PATTERNS. Arc LB pins reads to a specific block
  // and the chosen RPC may not have caught up yet, returning "block not
  // found" / "header not found" / "block at number". These are pure
  // eventual-consistency transients (the Gemini 2026-05-25 P0 fix already
  // added them on the agent side; this is the missing MCP side).
  return /timeout|temporarily unavailable|rate limit|too many requests|429|500|502|503|504|ECONNRESET|ETIMEDOUT|fetch failed|network error|context cancel|context deadline|block not found|header not found|block at number/i.test(
    message,
  );
}

// audit 2026-05-22 Tema 3 / MC-11 — explicit retry wrapper export. arcClient
// monkey-patched (aşağıda) zaten retry'a sahip ama tool dosyalarının üst-düzey
// try/catch içinden açıkça `readContractWithRetry` çağırması iki avantaj sağlar:
//   (1) niyet okunaklı (caller "burada RPC blip'i yutuyorum" der)
//   (2) caller readContractQuorum ile karıştırmak isterse direkt erişim açık
export async function readContractWithRetry(args: any): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= READ_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await rawReadContract(args);
    } catch (e) {
      lastErr = e;
      if (!isRetryableReadError(e) || attempt >= READ_RETRY_MAX_ATTEMPTS) throw e;
      const delay = Math.min(
        READ_RETRY_MAX_DELAY_MS,
        READ_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

Object.assign(arcClient, {
  readContract: readContractWithRetry as typeof arcClient.readContract,
});

// ── 2026-05-17 Codex Round 2 mainnet RPC sync ── PR #19 scope.
//
// Üç katmanlı state-validate:
//   (A) waitHeadsAtLeast(minBlock) — bütün read client'larının head'i en az
//       minBlock olana kadar bekle (read-after-write barrier — write yapan
//       caller receipt.blockNumber'ı tool'a aktarır)
//   (B) readContractQuorum(args, opts) — k-of-n eşit JSON karşılaştırması
//       (BigInt ve nested obje guard'lı). Quorum sağlanmazsa exp-backoff retry.
//   (C) Caller (smoke/brain) write receipt.blockNumber'ı bir sonraki read
//       tool çağrısının `minBlock` arg'ına geçirir → read pinned + barrier.

export class StateNotFinalError extends Error {
  constructor(public readonly args: { last?: unknown; quorum?: number; required: number; attempts: number }) {
    super(
      `E_STATE_NOT_FINAL — quorum not reached after ${args.attempts} attempt(s); required=${args.required} got=${args.quorum ?? 0}`,
    );
    this.name = "StateNotFinalError";
  }
}

/**
 * Wait until at least `k` read clients' reported block numbers are >= `minBlock`.
 * Used as read-after-write barrier: write tx receipt'inin block'unu MCP read
 * tool'una `minBlock` olarak geçirirsin, böylece henüz bu block'u görmemiş
 * stale RPC'lerden veri okumayı engellersin.
 *
 * Tek-URL setup'ta hızlı path: tek client polled.
 *
 * Codex 2026-05-24 audit P2-5 — eski "all clients" semantiği availability
 * tarafında kırılgandı: 3 sağlayıcılı prod kurulumda 1 sağlayıcı down/stale
 * ise 2/3 quorum sağlanabilecek bile olsa timeout veriyordu. Yeni davranış
 * quorum-aware:
 *   - default k = readContractQuorum'un quorum eşiği (min(2, N)) — yani
 *     kim quorum sağlıyorsa onunla aynı anlamda barrier de geçer.
 *   - opts.k ile çağıran override edebilir.
 *   - ARC_MCP_HEAD_WAIT_REQUIRE_ALL=1 ile eski "tüm clientlar" davranışını
 *     explicit geri getir (consistency > availability operasyonel tercihi).
 *   - Timeout mesajı hangi URL'lerin geride kaldığını listeler — operatör
 *     hangi sağlayıcının patladığını ilk bakışta görür.
 */
export async function waitHeadsAtLeast(
  minBlock: bigint,
  opts: { timeoutMs?: number; pollMs?: number; k?: number } = {},
): Promise<void> {
  if (minBlock <= 0n) return;
  const timeoutMs = opts.timeoutMs ?? HEAD_WAIT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? HEAD_WAIT_POLL_MS;
  const N = arcReadClients.length;
  const requireAll = process.env.ARC_MCP_HEAD_WAIT_REQUIRE_ALL === "1";
  const requestedK = opts.k ?? QUORUM_K;
  const k = requireAll
    ? N
    : Math.min(N, Math.max(1, requestedK));
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot: Array<{ url?: string; head: bigint | "err" }> = [];
  while (Date.now() < deadline) {
    const heads = await Promise.allSettled(
      arcReadClients.map((c) => c.getBlockNumber()),
    );
    lastSnapshot = heads.map((h, i) => {
      const url = (READ_URLS as readonly string[])[i];
      return {
        url,
        head: h.status === "fulfilled" ? h.value : "err",
      };
    });
    const ahead = heads.filter(
      (h) => h.status === "fulfilled" && h.value >= minBlock,
    ).length;
    if (ahead >= k) return;
    await sleep(pollMs);
  }
  const laggards = lastSnapshot
    .map(({ url, head }) => {
      if (head === "err") return `${shortUrl(url)}=ERR`;
      if (head < minBlock) return `${shortUrl(url)}=${head}(behind ${minBlock - head})`;
      return null;
    })
    .filter((s): s is string => s !== null);
  throw new Error(
    `E_HEAD_WAIT_TIMEOUT — only ${lastSnapshot.filter((s) => s.head !== "err" && s.head >= minBlock).length}/${N} read clients reached block ${minBlock} within ${timeoutMs}ms (need ${k}). Laggards: ${laggards.join(", ") || "(none — race)"}`,
  );
}

function shortUrl(u: string | undefined): string {
  if (!u) return "(unknown)";
  try {
    const host = new URL(u).host;
    return host.length > 40 ? `${host.slice(0, 37)}…` : host;
  } catch {
    return u.length > 40 ? `${u.slice(0, 37)}…` : u;
  }
}

/**
 * Stable JSON for quorum comparison. BigInt → decimal string; sorted object
 * keys; arrays preserved in order. Tuple-returning ABI fonksiyonları array
 * döndürür — sıra korunur.
 */
function stableStringify(value: unknown): string {
  if (typeof value === "bigint") return `"${value.toString()}n"`;
  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface QuorumOptions {
  /** Quorum eşiği (min eşit yanıt). Default ENV ARC_MCP_QUORUM_K ya da min(2, N) */
  k?: number;
  /** Read pinning — bu block'tan oku. Set ise tüm client'lar aynı block'tan okur. */
  blockNumber?: bigint;
  /** Read-after-write barrier — bu block'a ulaşılmadan başlama */
  minBlock?: bigint;
  attempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Etiket (log için, opsiyonel) */
  label?: string;
}

/**
 * K-of-N quorum read across `arcReadClients`. Tek-URL setup'ta tek read yapar
 * (quorum no-op). Multi-URL setup'ta paralel okur, k eşit sonuç beklenir.
 *
 * Eşit değilse: backoff retry. Tüm attempt'ler sonrası StateNotFinalError.
 *
 * `blockNumber` set ise tüm client'lar o block'tan okur (pinned read). Aksi
 * halde her client kendi head'inden okur (race riski — quorum yakalar).
 */
export async function readContractQuorum<T = unknown>(
  args: Parameters<PublicClient["readContract"]>[0],
  opts: QuorumOptions = {},
): Promise<T> {
  if (opts.minBlock !== undefined) {
    // Codex 2026-05-25 P2 audit — pass `k` to the head barrier. Without this
    // the head wait used default QUORUM_K even when the caller explicitly
    // asked for stricter (or looser) quorum, masking caller intent.
    await waitHeadsAtLeast(opts.minBlock, { k: opts.k });
  }

  const N = arcReadClients.length;
  const k = Math.min(N, opts.k ?? QUORUM_K);
  const attempts = opts.attempts ?? QUORUM_ATTEMPTS;
  const backoffBase = opts.backoffBaseMs ?? QUORUM_BACKOFF_BASE_MS;
  const backoffMax = opts.backoffMaxMs ?? QUORUM_BACKOFF_MAX_MS;

  // Tek client veya k=1: quorum no-op, retry'lı tek-client read.
  // Codex 2026-05-24 audit P2-3 — eski kod `rawReadContract` çağırıyordu
  // (retry'sız). Yorum "readContractWithRetry" diyordu ama implementasyon
  // bypass ediyordu; tek-URL prod kurulumunda transient 429/timeout doğrudan
  // tool hatasına dönüyordu. Burada explicit retry wrapper'ı kullan ki tek-URL
  // ve multi-URL aynı transient-koruma altında olsun.
  if (N === 1 || k <= 1) {
    const pinnedArgs = opts.blockNumber !== undefined
      ? { ...args, blockNumber: opts.blockNumber }
      : args;
    return (await readContractWithRetry(
      pinnedArgs as Parameters<PublicClient["readContract"]>[0],
    )) as T;
  }

  const pinnedArgs = opts.blockNumber !== undefined
    ? { ...args, blockNumber: opts.blockNumber }
    : args;

  let lastQuorum = 0;
  let lastValue: T | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const settled = await Promise.allSettled(
      arcReadClients.map((c) =>
        c.readContract(pinnedArgs as Parameters<PublicClient["readContract"]>[0]),
      ),
    );
    const buckets = new Map<string, { count: number; value: unknown }>();
    for (const s of settled) {
      if (s.status !== "fulfilled") continue;
      const key = stableStringify(s.value);
      const b = buckets.get(key);
      if (b) b.count += 1;
      else buckets.set(key, { count: 1, value: s.value });
    }
    let bestCount = 0;
    let bestValue: unknown;
    for (const b of buckets.values()) {
      if (b.count > bestCount) {
        bestCount = b.count;
        bestValue = b.value;
      }
    }
    if (bestCount >= k) {
      return bestValue as T;
    }
    lastQuorum = bestCount;
    lastValue = bestValue as T;
    if (attempt < attempts) {
      const delay = Math.min(backoffMax, backoffBase * 2 ** (attempt - 1));
      await sleep(delay);
    }
  }
  throw new StateNotFinalError({
    last: lastValue,
    quorum: lastQuorum,
    required: k,
    attempts,
  });
}
