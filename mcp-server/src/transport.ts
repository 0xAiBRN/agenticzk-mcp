// audit 2026-05-22 MC-20 / Tema 8 — chains.ts god-module split (1/3): transport.
// Arc Testnet chain definition + viem PublicClient'lar + multi-RPC failover
// transport burada. RPC URL set'leri (primary + extras) ve per-URL ayrı client
// listesi (quorum read için, rpc-utils.ts kullanıyor) bu modülde tanımlı.
//
// NOT: arcClient'ın readContract'i rpc-utils.ts'te monkey-patch'leniyor
// (exp-backoff retry). Barrel "./chains.js" üzerinden import side-effect olarak
// rpc-utils yüklenir → patch garanti edilir.
import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { config } from "./config.js";

// 2026-05-16 — Codex burst rate root-cause handoff. arcClient transport,
// ARC_READ_RPC_URLS set ise viem fallback'e geçer (primary + extras, sıralı
// failover). Tek-URL ise eski davranış aynı kalır. Mevcut readContractWithRetry
// aşağıdaki wrapper aynı kalır → iki kademe koruma:
//   (1) viem fallback transport: bir provider 5xx/timeout verince diğerine geçer
//   (2) readContractWithRetry: 429/transient'leri exp-backoff ile yutar
// Primary = ARC_READ_RPC_URL || ARC_RPC. Extras = ARC_READ_RPC_URLS CSV.
const READ_PRIMARY = config.arcReadRpcUrl ?? config.arcRpc;
export const READ_URLS = Array.from(new Set([READ_PRIMARY, ...config.arcReadRpcUrls]));
const readTransport = READ_URLS.length === 1
  ? http(READ_URLS[0])
  : fallback(
      READ_URLS.map((u) => http(u)),
      { rank: false, retryCount: 0 },
    );

// F-07 (Codex pre-mainnet audit, 2026-05-20) — keep in sync with the canonical
// Arc chain def in agenticzk packages/agent-runner/src/chain.ts (ARC_TESTNET).
// MCP only READS (no tx signing, no multicall here), so the `fees` override and
// `contracts.multicall3` are intentionally omitted — but { id, nativeCurrency
// (USDC 18-dec) } MUST match the canonical definition.
export const arcTestnet = {
  id: config.arcChainId,
  name: "Arc Testnet",
  // Arc native gas: USDC 18-dec (ERC-20 görünüm 6-dec ama nativeCurrency
  // viem'in formatEther/formatUnits varsayılan dönüşlerinde 18 olmalı).
  // 2026-05-11 — Codex public-readiness audit P0-1 fix.
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: READ_URLS } },
} as const;

export const arcClient: PublicClient = createPublicClient({
  chain: arcTestnet,
  transport: readTransport,
});

// 2026-05-17 — Codex Round 2 mainnet stratejisi. Per-URL ayrı public client'lar
// quorum read için. arcClient (fallback) ile kıyasla: fallback tek RPC seçer +
// stale data'yı görmez (5xx vermediği sürece OK sayar). Quorum read N farklı
// RPC'den paralel okuyup k-of-n aynı değeri bekler — Arc RPC LB-level
// node-arası state propagation skew'unu (R-F3.12) bu katmanda yakalar.
// Tek-URL fallback'de quorum no-op (degenerate path), birinci client geri döner.
export const arcReadClients: PublicClient[] = READ_URLS.map((url) =>
  createPublicClient({
    chain: arcTestnet,
    transport: http(url),
  }),
);

/** Salt blockNumber okuma — head probe için kullanılabilir. */
export async function currentBlockNumber(): Promise<bigint> {
  return await arcClient.getBlockNumber();
}
