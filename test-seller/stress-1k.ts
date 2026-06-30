/**
 * Hardened 1K stress test.
 *
 * Beyond test-buyer.ts:
 *  - Latency histogram + p50/p95/p99/max/min/mean/stddev
 *  - Per-endpoint stats
 *  - Failure classification by error pattern
 *  - Deposit history with credit-time per deposit
 *  - TX-id uniqueness verification
 *  - Settlement reconciliation (seller /stats vs buyer counted)
 *  - Balance accounting (start - end - spent ≈ 0)
 *  - Failure timeline / clustering
 *
 * Env:
 *  TOTAL_CALLS (default 1000)
 *  DELAY_MS    (default 400)
 *  TOPUP_AT    (default 500) — call index where mid-run deposit triggers if needed
 *  INITIAL_DEPOSIT (default 5) USDC
 *  TOPUP_AMOUNT (default 5) USDC
 *  LOW_WATER (default 1.0 USDC) — preemptive trigger
 *  ARTIFACT (default ../demos/nano-1k-stress.json)
 */
// audit 2026-05-22 MC-17 / Tema 6 — dotenv replaces brittle manual parser.
import "dotenv/config";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { parseUnits } from "viem";
import fs from "fs";
import path from "path";

const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const TOTAL_CALLS = Number(process.env.TOTAL_CALLS ?? 1000);
const DELAY_MS = Number(process.env.DELAY_MS ?? 400);
const TOPUP_AT = Number(process.env.TOPUP_AT ?? 500);
const INITIAL_DEPOSIT = process.env.INITIAL_DEPOSIT ?? "5";
const TOPUP_AMOUNT = process.env.TOPUP_AMOUNT ?? "5";
const LOW_WATER_RAW = parseUnits(process.env.LOW_WATER ?? "1.0", 6);
const TARGET_AFTER_TOPUP = (parseUnits(TOPUP_AMOUNT, 6) * 4n) / 5n;
const ARTIFACT = process.env.ARTIFACT ?? "../demos/nano-1k-stress.json";
const NETWORK = "arcTestnet";

if (!BUYER_PRIVATE_KEY) { console.error("Missing BUYER_PRIVATE_KEY"); process.exit(1); }

type Endpoint = { url: string; method: "GET" | "POST"; price: number; body?: unknown; tag: string };
const endpoints: Endpoint[] = [
  { tag: "quote",      url: `${BASE_URL}/api/premium/quote`,      method: "GET",  price: 0.001 },
  { tag: "dataset",    url: `${BASE_URL}/api/premium/dataset`,    method: "GET",  price: 0.01 },
  { tag: "compute",    url: `${BASE_URL}/api/premium/compute`,    method: "POST", price: 0.0003, body: { text: "Arcent 1K stress" } },
  { tag: "agent-task", url: `${BASE_URL}/api/premium/agent-task`, method: "GET",  price: 0.03 },
];

type CallRow = {
  idx: number; tag: string; url: string; method: string;
  amount: string; transaction: string; status: number; latencyMs: number;
  ts: string;
};
type FailRow = { idx: number; tag: string; ts: string; ms: number; error: string; classified: string };
type DepositRow = {
  trigger: "initial" | "preemptive" | "reactive";
  triggeredAtCall: number;
  txHash: string;
  approvalTxHash: string | null;
  amount: string;
  startedAt: string;
  creditedAt: string | null;
  creditMs: number | null;
  startBalanceRaw: string;
  endBalanceRaw: string | null;
};

function classify(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("settlement")) return "settlement_fail";
  if (m.includes("insufficient") || m.includes("balance")) return "insufficient_balance";
  if (m.includes("timeout") || m.includes("etimedout")) return "timeout";
  if (m.includes("econnreset") || m.includes("econnrefused") || m.includes("network")) return "network";
  if (m.includes("nonce")) return "nonce";
  if (m.includes("rate") || m.includes("429")) return "rate_limit";
  if (m.includes("402")) return "payment_required";
  if (m.includes("500") || m.includes("internal")) return "server_5xx";
  return "other";
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[i];
}
function mean(arr: number[]): number { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

async function waitForCredit(g: GatewayClient, target: bigint, maxSec = 90): Promise<{ creditMs: number | null; finalRaw: bigint }> {
  const start = Date.now();
  for (let i = 0; i < Math.ceil(maxSec / 2); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const b = await g.getBalances();
    if (b.gateway.available >= target) return { creditMs: Date.now() - start, finalRaw: b.gateway.available };
  }
  const b = await g.getBalances();
  return { creditMs: null, finalRaw: b.gateway.available };
}

async function runDeposit(g: GatewayClient, trigger: DepositRow["trigger"], amount: string, atCall: number, deposits: DepositRow[]): Promise<void> {
  const before = await g.getBalances();
  const startedAt = new Date().toISOString();
  console.log(`  → ${trigger.toUpperCase()} deposit ${amount} USDC (call ${atCall}, balance ${before.gateway.formattedAvailable})`);
  const dep = await g.deposit(amount);
  console.log(`    tx ${dep.depositTxHash.slice(0, 12)}... waiting credit...`);
  const target = before.gateway.available + TARGET_AFTER_TOPUP;
  const { creditMs, finalRaw } = await waitForCredit(g, target);
  const row: DepositRow = {
    trigger,
    triggeredAtCall: atCall,
    txHash: dep.depositTxHash,
    approvalTxHash: dep.approvalTxHash ?? null,
    amount,
    startedAt,
    creditedAt: creditMs !== null ? new Date(Date.now()).toISOString() : null,
    creditMs,
    startBalanceRaw: before.gateway.available.toString(),
    endBalanceRaw: finalRaw.toString(),
  };
  deposits.push(row);
  console.log(`    ${creditMs !== null ? "credited in " + (creditMs / 1000).toFixed(1) + "s" : "TIMEOUT 90s"} → ${(Number(finalRaw) / 1e6).toFixed(4)} USDC`);
}

async function fetchSellerStats(): Promise<{ callCount: number; collectedUsdc: number } | null> {
  try {
    const r = await fetch(`${BASE_URL}/stats`);
    if (!r.ok) return null;
    const j = await r.json() as { callCount: number; totalCollectedUsdc: string };
    return { callCount: j.callCount, collectedUsdc: parseFloat(j.totalCollectedUsdc) };
  } catch { return null; }
}

async function main() {
  console.log(`\n=== Arcent Hardened 1K Stress Test ===`);
  console.log(`Calls: ${TOTAL_CALLS}, delay ${DELAY_MS}ms, topup at ${TOPUP_AT}, low-water ${LOW_WATER_RAW}\n`);

  const g = new GatewayClient({ chain: NETWORK, privateKey: BUYER_PRIVATE_KEY! });
  console.log(`Buyer: ${g.address}`);

  const startBalance = await g.getBalances();
  const walletToRaw = (formatted: string): bigint => parseUnits(formatted, 6);
  const startWalletRaw = walletToRaw(startBalance.wallet.formatted);
  const startGatewayRaw = startBalance.gateway.available;
  console.log(`Start wallet:  ${startBalance.wallet.formatted} USDC`);
  console.log(`Start Gateway: ${startBalance.gateway.formattedAvailable} USDC\n`);

  const deposits: DepositRow[] = [];
  const sellerStatsBefore = await fetchSellerStats();
  if (sellerStatsBefore) console.log(`Seller before:  ${sellerStatsBefore.callCount} calls, ${sellerStatsBefore.collectedUsdc} USDC\n`);

  // Initial deposit if Gateway low
  if (startGatewayRaw < parseUnits(INITIAL_DEPOSIT, 6) / 2n) {
    await runDeposit(g, "initial", INITIAL_DEPOSIT, 0, deposits);
  } else {
    console.log(`Skipping initial deposit (Gateway has ${startBalance.gateway.formattedAvailable})\n`);
  }

  const calls: CallRow[] = [];
  const fails: FailRow[] = [];
  const latencies: number[] = [];
  const txIdSet = new Set<string>();
  let dupTxIds = 0;
  let totalSpent = 0;
  const startAll = Date.now();

  for (let i = 0; i < TOTAL_CALLS; i++) {
    const idx = i + 1;
    const ep = endpoints[i % endpoints.length];

    // Preemptive top-up: every 50 calls check balance
    if (i > 0 && i % 50 === 0) {
      try {
        const b = await g.getBalances();
        if (b.gateway.available < LOW_WATER_RAW) {
          await runDeposit(g, "preemptive", TOPUP_AMOUNT, idx, deposits);
        }
      } catch (pe) {
        console.error(`  preemptive check err: ${(pe as Error).message}`);
      }
    }

    // Hard top-up at TOPUP_AT (regardless) — guarantees fresh credit window
    // Skip if preemptive already deposited at this exact index (avoids double-deposit at i=500)
    const justDeposited = deposits.length > 0 && deposits[deposits.length - 1].triggeredAtCall === idx;
    if (idx === TOPUP_AT && !justDeposited) {
      const b = await g.getBalances();
      if (b.gateway.available < parseUnits(TOPUP_AMOUNT, 6)) {
        await runDeposit(g, "preemptive", TOPUP_AMOUNT, idx, deposits);
      }
    }

    const t0 = Date.now();
    try {
      const r = await g.pay(ep.url, { method: ep.method, body: ep.body });
      const ms = Date.now() - t0;
      latencies.push(ms);
      const amount = parseFloat(r.formattedAmount);
      totalSpent += amount;
      if (txIdSet.has(r.transaction)) dupTxIds++;
      txIdSet.add(r.transaction);
      calls.push({
        idx, tag: ep.tag, url: ep.url, method: ep.method,
        amount: r.formattedAmount, transaction: r.transaction,
        status: r.status, latencyMs: ms,
        ts: new Date().toISOString(),
      });
      if (idx % 100 === 0 || idx === TOTAL_CALLS) {
        const elapsed = ((Date.now() - startAll) / 1000).toFixed(0);
        const successCount = calls.length;
        const failCount = fails.length;
        console.log(`[${idx}/${TOTAL_CALLS}] OK ${successCount} / FAIL ${failCount} | spent ${totalSpent.toFixed(4)} | ${elapsed}s elapsed | p50=${pct(latencies, 50)}ms p95=${pct(latencies, 95)}ms`);
      }
    } catch (e) {
      const ms = Date.now() - t0;
      const msg = (e as Error).message;
      const cls = classify(msg);
      fails.push({ idx, tag: ep.tag, ts: new Date().toISOString(), ms, error: msg, classified: cls });
      console.error(`#${idx} FAIL [${cls}]: ${msg.slice(0, 100)}`);
      // Reactive recovery if 5+ fails in last 10
      const recent = fails.filter(f => f.idx >= idx - 10);
      if (recent.length >= 5) {
        try {
          const b = await g.getBalances();
          if (b.gateway.available < BigInt(100_000)) {
            await runDeposit(g, "reactive", TOPUP_AMOUNT, idx, deposits);
          }
        } catch (re) {
          console.error(`  reactive deposit err: ${(re as Error).message}`);
        }
      }
    }

    if (i < TOTAL_CALLS - 1) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const totalElapsedSec = (Date.now() - startAll) / 1000;
  const endBalance = await g.getBalances();
  const endWalletRaw = walletToRaw(endBalance.wallet.formatted);
  const endGatewayRaw = endBalance.gateway.available;

  // Per-endpoint stats
  const epStats: Record<string, { count: number; spent: number; latencyMs: { p50: number; p95: number; p99: number; mean: number } }> = {};
  for (const ep of endpoints) {
    const sub = calls.filter(c => c.tag === ep.tag);
    const subLat = sub.map(c => c.latencyMs);
    epStats[ep.tag] = {
      count: sub.length,
      spent: sub.reduce((s, c) => s + parseFloat(c.amount), 0),
      latencyMs: {
        p50: pct(subLat, 50),
        p95: pct(subLat, 95),
        p99: pct(subLat, 99),
        mean: Math.round(mean(subLat)),
      },
    };
  }

  // Fault classification
  const faultBreakdown: Record<string, number> = {};
  for (const f of fails) faultBreakdown[f.classified] = (faultBreakdown[f.classified] || 0) + 1;

  // Settlement reconciliation
  const sellerStatsAfter = await fetchSellerStats();
  let reconciliation: Record<string, unknown> = { seller_unreachable: true };
  if (sellerStatsBefore && sellerStatsAfter) {
    const sellerDeltaCalls = sellerStatsAfter.callCount - sellerStatsBefore.callCount;
    const sellerDeltaUsdc = sellerStatsAfter.collectedUsdc - sellerStatsBefore.collectedUsdc;
    reconciliation = {
      buyer_settled_calls: calls.length,
      seller_delta_calls: sellerDeltaCalls,
      diff_calls: calls.length - sellerDeltaCalls,
      buyer_spent_usdc: Number(totalSpent.toFixed(6)),
      seller_delta_usdc: Number(sellerDeltaUsdc.toFixed(6)),
      diff_usdc: Number((totalSpent - sellerDeltaUsdc).toFixed(6)),
      match: calls.length === sellerDeltaCalls && Math.abs(totalSpent - sellerDeltaUsdc) < 0.000001,
    };
  }

  // Balance accounting: (startWallet + startGateway) - (endWallet + endGateway) should ≈ totalSpent + gas
  const startTotalRaw = startWalletRaw + startGatewayRaw;
  const endTotalRaw = endWalletRaw + endGatewayRaw;
  const totalDepositedUsdcRaw = deposits.reduce((s, d) => s + parseUnits(d.amount, 6), 0n);
  // movement = wallet→gateway via deposit (no value loss except gas) + gateway→seller via pay (value loss = totalSpent)
  // Therefore: startTotal - endTotal ≈ totalSpent + gasUsedByDeposits
  const accountedSpent = Number(startTotalRaw - endTotalRaw) / 1e6;
  const impliedGas = Math.max(0, accountedSpent - totalSpent);

  // Fault timeline (cluster: how many in groups of 50 buckets)
  const failBuckets: Record<string, number> = {};
  for (const f of fails) {
    const bucket = Math.floor((f.idx - 1) / 50) * 50;
    const key = `${bucket}-${bucket + 49}`;
    failBuckets[key] = (failBuckets[key] || 0) + 1;
  }

  const artifact = {
    title: "Arcent Nano — 1K hardened stress test",
    network: NETWORK,
    buyer: g.address,
    seller: BASE_URL,
    config: { TOTAL_CALLS, DELAY_MS, TOPUP_AT, INITIAL_DEPOSIT, TOPUP_AMOUNT, LOW_WATER_USDC: Number(LOW_WATER_RAW) / 1e6 },
    summary: {
      attempted: TOTAL_CALLS,
      settled: calls.length,
      failed: fails.length,
      successRate: Number(((calls.length / TOTAL_CALLS) * 100).toFixed(2)),
      totalSpentUsdc: Number(totalSpent.toFixed(6)),
      elapsedSec: Number(totalElapsedSec.toFixed(1)),
      callsPerSec: Number((calls.length / totalElapsedSec).toFixed(2)),
      depositsCount: deposits.length,
      duplicateTxIds: dupTxIds,
      uniqueTxIds: txIdSet.size,
    },
    latencyMs: {
      p50: pct(latencies, 50),
      p95: pct(latencies, 95),
      p99: pct(latencies, 99),
      max: latencies.length ? Math.max(...latencies) : 0,
      min: latencies.length ? Math.min(...latencies) : 0,
      mean: Math.round(mean(latencies)),
      stddev: Math.round(stddev(latencies)),
    },
    perEndpoint: epStats,
    faultBreakdown,
    failureTimeline: failBuckets,
    deposits,
    settlementReconciliation: reconciliation,
    balanceAccounting: {
      startWalletUsdc: Number(startWalletRaw) / 1e6,
      startGatewayUsdc: Number(startGatewayRaw) / 1e6,
      endWalletUsdc: Number(endWalletRaw) / 1e6,
      endGatewayUsdc: Number(endGatewayRaw) / 1e6,
      totalDepositedUsdc: Number(totalDepositedUsdcRaw) / 1e6,
      accountedSpentUsdc: Number(accountedSpent.toFixed(6)),
      reportedSpentUsdc: Number(totalSpent.toFixed(6)),
      impliedGasUsdc: Number(impliedGas.toFixed(6)),
    },
    marginComparison: {
      traditionalCctpGasPerCall: "~0.30",
      traditional1kCalls: "~300.00",
      nanoTotalGas: Number(impliedGas.toFixed(6)),
      nanoTotalSpend: Number(totalSpent.toFixed(6)),
      gasSavingsVsTraditional: `${Math.round(300 / Math.max(impliedGas, 0.001))}x`,
    },
    sellerStatsBefore,
    sellerStatsAfter,
    fails,
    calls,
    timestamp: new Date().toISOString(),
  };

  // Console summary
  console.log(`\n========== SUMMARY ==========`);
  console.log(`Settled:        ${calls.length} / ${TOTAL_CALLS} (${artifact.summary.successRate}%)`);
  console.log(`Failed:         ${fails.length}`);
  console.log(`Spent:          ${totalSpent.toFixed(6)} USDC`);
  console.log(`Implied gas:    ${impliedGas.toFixed(6)} USDC across ${deposits.length} deposits`);
  console.log(`Elapsed:        ${totalElapsedSec.toFixed(1)}s (${artifact.summary.callsPerSec} calls/s)`);
  console.log(`Latency:        p50=${artifact.latencyMs.p50}ms p95=${artifact.latencyMs.p95}ms p99=${artifact.latencyMs.p99}ms (max ${artifact.latencyMs.max}ms)`);
  console.log(`TX uniqueness:  ${txIdSet.size} unique / ${dupTxIds} dups`);
  if (Object.keys(faultBreakdown).length) {
    console.log(`Faults:         ${JSON.stringify(faultBreakdown)}`);
  }
  if ("match" in reconciliation) {
    console.log(`Reconciliation: ${(reconciliation as { match: boolean }).match ? "MATCH ✓" : "MISMATCH ✗"} — ${JSON.stringify(reconciliation)}`);
  }
  console.log(`Per-endpoint:`);
  for (const [tag, s] of Object.entries(epStats)) {
    console.log(`  ${tag.padEnd(11)} ${String(s.count).padStart(4)} calls, ${s.spent.toFixed(4)} USDC, p50=${s.latencyMs.p50}ms p95=${s.latencyMs.p95}ms`);
  }

  const outPath = path.resolve(ARTIFACT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(`\nArtifact: ${outPath}\n`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
