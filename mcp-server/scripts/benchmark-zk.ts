// H8 benchmark — snarkjs vs rapidsnark shuffle prove timing (52 cards).
//
// Çalıştırma:
//   cd <agenticzk-mcp>/mcp-server
//   npx tsx scripts/benchmark-zk.ts
//
// 2026-05-19 — v2arastir 60-source rapor H8 doğrulaması.
// Hipotez: snarkjs ~20s → rapidsnark ~3-5s (4-7× hızlanma).
// Aynı witness, aynı zkey, aynı public signals — sadece prove adımı native C++.

import { buildShuffleWitness, seededRng } from "../src/zk/shuffle-input.js";
import { SnarkjsShuffleProver, RapidsnarkShuffleProver } from "../src/zk/prover.js";
import { config } from "../src/config.js";
import { buildBabyjub } from "circomlibjs";

const DECK = 52;
const SEED = 99n;

type Point = [bigint, bigint];

async function mockInitialDeck(): Promise<{ pk: Point; inputC1: Point[]; inputC2: Point[] }> {
  const bj = await buildBabyjub();
  const G = bj.Base8;

  // Session pk = sk · G (sk küçük ama geçerli — sadece benchmark için).
  const sk = 12345n;
  const pkPt = bj.mulPointEscalar(G, sk);
  const pk: Point = [BigInt(bj.F.toString(pkPt[0])), BigInt(bj.F.toString(pkPt[1]))];

  // 52 ElGamal ciphertext: msg_i = (i+1)·G, fresh randomness r_i.
  const inputC1: Point[] = [];
  const inputC2: Point[] = [];
  for (let i = 0; i < DECK; i++) {
    const r = BigInt(101 + i * 13);
    const c1 = bj.mulPointEscalar(G, r);
    const c2partial = bj.mulPointEscalar(pkPt, r);
    const msg = bj.mulPointEscalar(G, BigInt(i + 1));
    const c2 = bj.addPoint(c2partial, msg);
    inputC1.push([BigInt(bj.F.toString(c1[0])), BigInt(bj.F.toString(c1[1]))]);
    inputC2.push([BigInt(bj.F.toString(c2[0])), BigInt(bj.F.toString(c2[1]))]);
  }
  return { pk, inputC1, inputC2 };
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;
}

async function main() {
  console.log("[H8 benchmark] witness build başlıyor...");
  const deck = await mockInitialDeck();
  const rng = seededRng(SEED);
  const t0 = performance.now();
  const wIn = await buildShuffleWitness(deck, rng);
  const t1 = performance.now();
  console.log(`[H8] witness build: ${fmtMs(t1 - t0)} (52 kart, BabyJub re-encrypt)`);

  // ZK Shuffle Gas milestone (2026-05-21) — the shuffle is now three circuits.
  // Benchmark the `first` circuit: it is a full 211-public-signal anchor-deck
  // circuit, the most representative of prove-time cost (mid is smaller).
  console.log(`[H8] zkey: ${config.zkShuffleFirstZkey}`);
  console.log(`[H8] wasm: ${config.zkShuffleFirstWasm}`);
  console.log(`[H8] rapidsnark bin: ${config.zkRapidsnarkBin}`);

  // ---- snarkjs ----
  console.log("\n[H8] snarkjs prove başlıyor (~20s bekleyin)...");
  const snark = new SnarkjsShuffleProver(config.zkShuffleFirstWasm, config.zkShuffleFirstZkey);
  const sR = await snark.prove(wIn.witness);
  console.log(`[H8] snarkjs ✓ totalMs=${fmtMs(sR.timings.totalMs)} proveMs=${fmtMs(sR.timings.proveMs)}`);

  // ---- rapidsnark ----
  console.log("\n[H8] rapidsnark prove başlıyor (~3-5s bekleyin)...");
  const rapid = new RapidsnarkShuffleProver(config.zkShuffleFirstWasm, config.zkShuffleFirstZkey, config.zkRapidsnarkBin);
  const rR = await rapid.prove(wIn.witness);
  console.log(`[H8] rapidsnark ✓ totalMs=${fmtMs(rR.timings.totalMs)} witnessMs=${fmtMs(rR.timings.witnessMs)} proveMs=${fmtMs(rR.timings.proveMs)}`);

  // ---- compare ----
  console.log("\n=== H8 SONUÇ ===");
  console.log(`snarkjs total:    ${fmtMs(sR.timings.totalMs)}`);
  console.log(`rapidsnark total: ${fmtMs(rR.timings.totalMs)}`);
  const speedup = sR.timings.totalMs / rR.timings.totalMs;
  console.log(`hızlanma:         ${speedup.toFixed(2)}× (rapor hedef: 4-7×)`);

  // ---- soundness sanity ----
  const samePublic = JSON.stringify(sR.publicSignals) === JSON.stringify(rR.publicSignals);
  console.log(`publicSignals eşit: ${samePublic ? "✓ EVET (proof soundness aynı witness için reproducible)" : "✗ HAYIR — INCELE!"}`);
  if (!samePublic) {
    console.log("  snarkjs[0..3]:    ", sR.publicSignals.slice(0, 3));
    console.log("  rapidsnark[0..3]: ", rR.publicSignals.slice(0, 3));
  }
}

main().catch((e) => {
  console.error("[H8 benchmark] FATAL:", e);
  process.exit(1);
});
