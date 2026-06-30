// audit 2026-05-22 MC-17 / Tema 6 — dotenv replaces brittle manual parser.
import "dotenv/config";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import fs from "fs";
import path from "path";

const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT ?? "1";
const TOTAL_CALLS = Number(process.env.TOTAL_CALLS ?? 50);
const DELAY_MS = Number(process.env.DELAY_MS ?? 1200);
const NETWORK = "arcTestnet";

if (!BUYER_PRIVATE_KEY) {
  console.error("Missing BUYER_PRIVATE_KEY. Run: npm run generate-wallets");
  process.exit(1);
}

const endpoints = [
  { url: `${BASE_URL}/api/premium/quote`, method: "GET" as const, price: 0.001 },
  { url: `${BASE_URL}/api/premium/dataset`, method: "GET" as const, price: 0.01 },
  { url: `${BASE_URL}/api/premium/compute`, method: "POST" as const, price: 0.0003, body: { text: "Arcent nano demo payload" } },
  { url: `${BASE_URL}/api/premium/agent-task`, method: "GET" as const, price: 0.03 },
];

async function main() {
  const gateway = new GatewayClient({ chain: NETWORK, privateKey: BUYER_PRIVATE_KEY! });
  console.log(`Buyer: ${gateway.address}`);
  console.log(`Network: ${NETWORK}`);
  console.log(`Seller: ${BASE_URL}\n`);

  const startBalance = await gateway.getBalances();
  console.log(`Wallet USDC before:      ${startBalance.wallet.formatted}`);
  console.log(`Gateway available before: ${startBalance.gateway.formattedAvailable}\n`);

  let depositTxHash = "skipped (sufficient balance)";
  let approvalTxHash: string | null = null;

  if (process.env.SKIP_DEPOSIT === "1") {
    console.log(`SKIP_DEPOSIT=1 → skipping deposit, using existing Gateway balance\n`);
  } else {
    console.log(`Depositing ${DEPOSIT_AMOUNT} USDC into Gateway...`);
    const deposit = await gateway.deposit(DEPOSIT_AMOUNT);
    depositTxHash = deposit.depositTxHash;
    approvalTxHash = deposit.approvalTxHash ?? null;
    console.log(`  ✓ depositTxHash: ${deposit.depositTxHash}`);
    if (deposit.approvalTxHash) console.log(`  ✓ approvalTxHash: ${deposit.approvalTxHash}`);
  }

  const afterDeposit = await gateway.getBalances();
  console.log(`\nWallet USDC after deposit:  ${afterDeposit.wallet.formatted}`);
  console.log(`Gateway available:          ${afterDeposit.gateway.formattedAvailable}\n`);

  const results: { idx: number; url: string; method: string; amount: string; transaction: string; status: number; latencyMs: number }[] = [];
  let totalSpent = 0;

  console.log(`Running ${TOTAL_CALLS} nano_pay calls round-robin across ${endpoints.length} endpoints (${DELAY_MS}ms between calls)...\n`);

  let failCount = 0;
  const startAll = Date.now();

  for (let i = 0; i < TOTAL_CALLS; i++) {
    // Preemptive balance check every 50 calls — avoids fail-then-recover pattern
    if (i > 0 && i % 50 === 0) {
      try {
        const b = await gateway.getBalances();
        if (b.gateway.available < 500_000n) { // < 0.5 USDC → top up before it runs out
          console.log(`  → Preemptive redeposit (current: ${b.gateway.formattedAvailable})...`);
          const rd = await gateway.deposit("1");
          console.log(`  → Deposited (tx ${rd.depositTxHash.slice(0, 10)}...), waiting for Gateway credit...`);
          // Wait up to 90s for Gateway attestation + mint
          for (let j = 0; j < 45; j++) {
            await new Promise((r) => setTimeout(r, 2000));
            const nb = await gateway.getBalances();
            if (nb.gateway.available > 800_000n) {
              console.log(`  → Credited after ${(j + 1) * 2}s: ${nb.gateway.formattedAvailable}`);
              break;
            }
          }
        }
      } catch (pe) {
        console.error(`  preemptive check failed: ${(pe as Error).message}`);
      }
    }

    const ep = endpoints[i % endpoints.length];
    const start = Date.now();
    try {
      const r = await gateway.pay(ep.url, { method: ep.method, body: (ep as { body?: unknown }).body });
      const ms = Date.now() - start;
      const amount = parseFloat(r.formattedAmount);
      totalSpent += amount;
      results.push({ idx: i + 1, url: ep.url, method: ep.method, amount: r.formattedAmount, transaction: r.transaction, status: r.status, latencyMs: ms });
      if ((i + 1) % 50 === 0 || i + 1 === TOTAL_CALLS) {
        const elapsed = ((Date.now() - startAll) / 1000).toFixed(0);
        console.log(`[${i + 1}/${TOTAL_CALLS}] elapsed ${elapsed}s, spent ${totalSpent.toFixed(4)} USDC, fails ${failCount}`);
      }
    } catch (e) {
      failCount++;
      console.error(`#${i + 1} FAILED: ${(e as Error).message}`);
      // Reactive fallback: if preemptive check missed it, try recovery
      if (failCount % 10 === 0) {
        try {
          const b = await gateway.getBalances();
          if (b.gateway.available < 100_000n) {
            console.log(`  → Emergency redeposit (balance ${b.gateway.formattedAvailable})...`);
            const rd = await gateway.deposit("1");
            console.log(`  → Deposited, waiting for credit...`);
            for (let j = 0; j < 45; j++) {
              await new Promise((r) => setTimeout(r, 2000));
              const nb = await gateway.getBalances();
              if (nb.gateway.available > 800_000n) {
                console.log(`  → Credited: ${nb.gateway.formattedAvailable}`);
                break;
              }
            }
          }
        } catch (re) {
          console.error(`  redeposit check failed: ${(re as Error).message}`);
        }
      }
    }
    if (i < TOTAL_CALLS - 1) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const endBalance = await gateway.getBalances();
  console.log(`\n=== Results ===`);
  console.log(`Total calls:              ${results.length} / ${TOTAL_CALLS}`);
  console.log(`Total spent:              ${totalSpent.toFixed(6)} USDC`);
  console.log(`Gateway available end:    ${endBalance.gateway.formattedAvailable}`);
  console.log(`Wallet USDC end:          ${endBalance.wallet.formatted}`);

  const artifact = {
    title: "Arcent Nano — 50+ tx E2E demo",
    network: NETWORK,
    buyer: gateway.address,
    seller: BASE_URL,
    depositAmount: process.env.SKIP_DEPOSIT === "1" ? "skipped" : DEPOSIT_AMOUNT,
    depositTxHash,
    approvalTxHash,
    totalCalls: results.length,
    totalSpentUsdc: totalSpent.toFixed(6),
    endpoints: endpoints.map(e => ({ url: e.url, method: e.method, price: e.price })),
    marginComparison: {
      traditionalCctpGasPerCall: "~0.30",
      traditional50calls: "~15.00",
      nanoGasTotal: "~0.05",
      nanoSpend: totalSpent.toFixed(6),
      gasSavings: "300x+",
    },
    calls: results,
    timestamp: new Date().toISOString(),
  };

  const outPath = path.resolve("../demos/nano-e2e.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(`\nArtifact written: ${outPath}\n`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
