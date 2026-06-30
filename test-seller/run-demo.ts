/**
 * Live demo orchestration for video recording. Runs ~45 seconds.
 * Flow: balances → deposit 0.3 USDC → wait for credit → 15 nano_pay calls → summary.
 *
 * Env: BUYER_PRIVATE_KEY in .env. Seller on :3000 (npm run dev).
 * Usage: npx tsx run-demo.ts
 */
// audit 2026-05-22 MC-17 / Tema 6 — dotenv replaces brittle manual parser.
import "dotenv/config";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { parseUnits, formatUnits } from "viem";
import fs from "fs";
import path from "path";

const BUYER_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
const BASE_URL = "http://localhost:3000";
const NETWORK = "arcTestnet";

if (!BUYER_KEY) {
  console.error("FATAL: BUYER_PRIVATE_KEY missing in test-seller/.env");
  process.exit(1);
}

type Endpoint = { tag: string; url: string; method: "GET" | "POST"; price: string; body?: unknown };
const endpoints: Endpoint[] = [
  { tag: "quote",      url: "/api/premium/quote",      method: "GET",  price: "$0.001"  },
  { tag: "dataset",    url: "/api/premium/dataset",    method: "GET",  price: "$0.01"   },
  { tag: "compute",    url: "/api/premium/compute",    method: "POST", price: "$0.0003", body: { text: "demo" } },
  { tag: "agent-task", url: "/api/premium/agent-task", method: "GET",  price: "$0.03"   },
];

function banner(msg: string) {
  const line = "=".repeat(60);
  console.log(`\n${line}\n  ${msg}\n${line}`);
}

function stage(n: number, msg: string) {
  console.log(`\n[${n}] ${msg}`);
}

async function main() {
  banner("Arcent Nano - Live Demo");

  const probe = await fetch(`${BASE_URL}/stats`).catch(() => null);
  if (!probe || !probe.ok) {
    console.error("\nERROR: Seller not reachable at " + BASE_URL);
    console.error("Start it: cd test-seller && npm run dev\n");
    process.exit(1);
  }

  const g = new GatewayClient({ chain: NETWORK, privateKey: BUYER_KEY! });

  stage(1, "Buyer balances");
  const before = await g.getBalances();
  console.log(`    Address:  ${g.address}`);
  console.log(`    Wallet:   ${before.wallet.formatted} USDC`);
  console.log(`    Gateway:  ${before.gateway.formattedAvailable} USDC`);

  stage(2, "Deposit 0.3 USDC to Circle Gateway");
  const depStart = Date.now();
  const dep = await g.deposit("0.3");
  console.log(`    Tx hash:  ${dep.depositTxHash}`);
  console.log(`    Explorer: https://testnet.arcscan.app/tx/${dep.depositTxHash}`);

  stage(3, "Wait for attestation credit");
  const target = before.gateway.available + BigInt(250_000);
  let creditMs: number | null = null;
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const b = await g.getBalances();
    if (b.gateway.available >= target) {
      creditMs = Date.now() - depStart;
      console.log(`    Credited in ${(creditMs / 1000).toFixed(1)}s. Gateway: ${b.gateway.formattedAvailable} USDC`);
      break;
    }
  }
  if (creditMs === null) {
    console.error("    Credit timeout after 45s. Aborting.");
    process.exit(1);
  }

  stage(4, "Execute 15 nano_pay calls (round-robin 4 endpoints)");
  let totalSpentRaw = 0n;
  const latencies: number[] = [];
  for (let i = 0; i < 15; i++) {
    const ep = endpoints[i % endpoints.length];
    const t0 = Date.now();
    const r = await g.pay(`${BASE_URL}${ep.url}`, { method: ep.method, body: ep.body });
    const ms = Date.now() - t0;
    latencies.push(ms);
    totalSpentRaw += parseUnits(r.formattedAmount, 6);
    const idx = String(i + 1).padStart(2);
    console.log(`    ${idx}/15  ${ep.tag.padEnd(11)} ${ep.price.padStart(8)}  ${String(ms).padStart(4)}ms  tx=${r.transaction.slice(0, 8)}...`);
    if (i < 14) await new Promise((r) => setTimeout(r, 300 + Math.floor(Math.random() * 500)));
  }

  stage(5, "Summary");
  const after = await g.getBalances();
  const avgLat = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  console.log(`    Settled:     15 / 15`);
  console.log(`    Spent:       ${formatUnits(totalSpentRaw, 6)} USDC`);
  console.log(`    Avg latency: ${avgLat}ms`);
  console.log(`    Gateway:     ${before.gateway.formattedAvailable} -> ${after.gateway.formattedAvailable} USDC`);

  banner("Full 1K proof: demos/nano-1k-stress.json - 1000/1000, reconciliation MATCH");
}

main().catch((e) => {
  console.error("\nFATAL:", (e as Error).message);
  process.exit(1);
});
