/**
 * Edge-case probes. Run AFTER stress-1k (or independently, ~50 calls total).
 *  Probe 1: Parallel — 10 concurrent calls (race condition detection)
 *  Probe 2: Burst   — 20 calls with zero delay (rate limit / server handling)
 *  Probe 3: Hammer  — 30 calls to a single endpoint (endpoint-specific stress)
 *  Probe 4: Cheap   — 20 calls to cheapest endpoint (amount-boundary)
 *  Probe 5: Bad URL — 3 calls to non-existent endpoint (404 handling)
 *  Probe 6: Re-init — instantiate new GatewayClient and call (state persistence)
 */
// audit 2026-05-22 MC-17 / Tema 6 — dotenv replaces brittle manual parser.
import "dotenv/config";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import fs from "fs";
import path from "path";

const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const NETWORK = "arcTestnet";

type ProbeResult = {
  name: string;
  ok: number;
  fail: number;
  details: Array<{ idx: number; ok: boolean; ms?: number; error?: string; txId?: string }>;
  notes: string;
  elapsedMs: number;
};

async function probeParallel(g: GatewayClient): Promise<ProbeResult> {
  const start = Date.now();
  const urls = [
    `${BASE_URL}/api/premium/quote`,
    `${BASE_URL}/api/premium/dataset`,
    `${BASE_URL}/api/premium/compute`,
    `${BASE_URL}/api/premium/agent-task`,
  ];
  const bodies: (unknown | undefined)[] = [undefined, undefined, { text: "p" }, undefined];
  const methods = ["GET", "GET", "POST", "GET"] as const;

  const promises = Array.from({ length: 10 }, (_, i) => {
    const k = i % urls.length;
    const t0 = Date.now();
    return g.pay(urls[k], { method: methods[k], body: bodies[k] })
      .then(r => ({ idx: i, ok: true as const, ms: Date.now() - t0, txId: r.transaction }))
      .catch(e => ({ idx: i, ok: false as const, ms: Date.now() - t0, error: (e as Error).message }));
  });

  const results = await Promise.all(promises);
  const ok = results.filter(r => r.ok).length;
  const txIds = new Set(results.filter(r => r.ok && "txId" in r).map(r => (r as { txId: string }).txId));
  return {
    name: "parallel_10",
    ok,
    fail: 10 - ok,
    details: results,
    notes: `${txIds.size} unique tx ids, ${results.filter(r => r.ok).length} settled concurrently`,
    elapsedMs: Date.now() - start,
  };
}

async function probeBurst(g: GatewayClient): Promise<ProbeResult> {
  const start = Date.now();
  const results: ProbeResult["details"] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = Date.now();
    try {
      const r = await g.pay(`${BASE_URL}/api/premium/compute`, { method: "POST", body: { text: "burst" } });
      results.push({ idx: i, ok: true, ms: Date.now() - t0, txId: r.transaction });
    } catch (e) {
      results.push({ idx: i, ok: false, ms: Date.now() - t0, error: (e as Error).message });
    }
    // no delay
  }
  return {
    name: "burst_20_nodelay",
    ok: results.filter(r => r.ok).length,
    fail: results.filter(r => !r.ok).length,
    details: results,
    notes: "20 sequential calls with 0ms delay — tests server throughput + gateway lane contention",
    elapsedMs: Date.now() - start,
  };
}

async function probeHammer(g: GatewayClient): Promise<ProbeResult> {
  const start = Date.now();
  const results: ProbeResult["details"] = [];
  for (let i = 0; i < 30; i++) {
    const t0 = Date.now();
    try {
      const r = await g.pay(`${BASE_URL}/api/premium/quote`, { method: "GET" });
      results.push({ idx: i, ok: true, ms: Date.now() - t0, txId: r.transaction });
    } catch (e) {
      results.push({ idx: i, ok: false, ms: Date.now() - t0, error: (e as Error).message });
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return {
    name: "hammer_quote_30",
    ok: results.filter(r => r.ok).length,
    fail: results.filter(r => !r.ok).length,
    details: results,
    notes: "30× same endpoint (quote @ $0.001) with 100ms cadence",
    elapsedMs: Date.now() - start,
  };
}

async function probeCheap(g: GatewayClient): Promise<ProbeResult> {
  const start = Date.now();
  const results: ProbeResult["details"] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = Date.now();
    try {
      const r = await g.pay(`${BASE_URL}/api/premium/compute`, { method: "POST", body: { text: "c" } });
      results.push({ idx: i, ok: true, ms: Date.now() - t0, txId: r.transaction });
    } catch (e) {
      results.push({ idx: i, ok: false, ms: Date.now() - t0, error: (e as Error).message });
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return {
    name: "cheap_compute_20",
    ok: results.filter(r => r.ok).length,
    fail: results.filter(r => !r.ok).length,
    details: results,
    notes: "20× cheapest endpoint (compute @ $0.0003) — amount-boundary / precision test",
    elapsedMs: Date.now() - start,
  };
}

async function probeBadUrl(g: GatewayClient): Promise<ProbeResult> {
  const start = Date.now();
  const results: ProbeResult["details"] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    try {
      const r = await g.pay(`${BASE_URL}/api/premium/does-not-exist`, { method: "GET" });
      results.push({ idx: i, ok: true, ms: Date.now() - t0, txId: r.transaction });
    } catch (e) {
      results.push({ idx: i, ok: false, ms: Date.now() - t0, error: (e as Error).message });
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return {
    name: "bad_url_3",
    ok: results.filter(r => r.ok).length,
    fail: results.filter(r => !r.ok).length,
    details: results,
    notes: "3× nonexistent endpoint — SHOULD fail gracefully without charging",
    elapsedMs: Date.now() - start,
  };
}

async function probeReinit(): Promise<ProbeResult> {
  const start = Date.now();
  const results: ProbeResult["details"] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    try {
      const freshG = new GatewayClient({ chain: NETWORK, privateKey: BUYER_PRIVATE_KEY });
      const r = await freshG.pay(`${BASE_URL}/api/premium/quote`, { method: "GET" });
      results.push({ idx: i, ok: true, ms: Date.now() - t0, txId: r.transaction });
    } catch (e) {
      results.push({ idx: i, ok: false, ms: Date.now() - t0, error: (e as Error).message });
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return {
    name: "reinit_5",
    ok: results.filter(r => r.ok).length,
    fail: results.filter(r => !r.ok).length,
    details: results,
    notes: "5× fresh GatewayClient per call — tests state persistence / nonce handling across instances",
    elapsedMs: Date.now() - start,
  };
}

async function main() {
  console.log(`\n=== Arcent Edge-Case Probe Suite ===\n`);
  const g = new GatewayClient({ chain: NETWORK, privateKey: BUYER_PRIVATE_KEY });
  const before = await g.getBalances();
  console.log(`Buyer: ${g.address}`);
  console.log(`Start Gateway: ${before.gateway.formattedAvailable} USDC\n`);

  const probes: ProbeResult[] = [];
  const runners = [
    { fn: () => probeParallel(g), name: "1. Parallel 10" },
    { fn: () => probeBurst(g), name: "2. Burst 20 no-delay" },
    { fn: () => probeHammer(g), name: "3. Hammer quote ×30" },
    { fn: () => probeCheap(g), name: "4. Cheap compute ×20" },
    { fn: () => probeBadUrl(g), name: "5. Bad URL ×3" },
    { fn: () => probeReinit(), name: "6. Re-init ×5" },
  ];

  for (const r of runners) {
    console.log(`--- ${r.name} ---`);
    try {
      const res = await r.fn();
      probes.push(res);
      console.log(`    ok=${res.ok} fail=${res.fail} elapsed=${res.elapsedMs}ms`);
      console.log(`    ${res.notes}\n`);
    } catch (e) {
      console.error(`    FATAL: ${(e as Error).message}\n`);
      probes.push({ name: r.name, ok: 0, fail: -1, details: [], notes: `fatal: ${(e as Error).message}`, elapsedMs: 0 });
    }
  }

  const after = await g.getBalances();
  console.log(`End Gateway: ${after.gateway.formattedAvailable} USDC`);

  const artifact = {
    title: "Arcent Nano — edge-case probes",
    network: NETWORK,
    buyer: g.address,
    seller: BASE_URL,
    startGateway: before.gateway.formattedAvailable,
    endGateway: after.gateway.formattedAvailable,
    probes,
    timestamp: new Date().toISOString(),
  };
  const out = path.resolve("../demos/nano-probes.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(artifact, null, 2));
  console.log(`\nArtifact: ${out}\n`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
