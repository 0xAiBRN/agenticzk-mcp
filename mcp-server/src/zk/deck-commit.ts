// Off-chain Poseidon deck commitment — ZK Shuffle Gas milestone (2026-05-21).
//
// Re-implements the `DeckCommit(52)` circuit template
// (agenticzk/packages/circuits/src/deck_commit.circom) in JS so the MCP can:
//
//   1. poker_shuffle_prove — for a round >= 1, the agent's input deck is read
//      from the previous round's ShuffleDeckEmitted event, NOT from a
//      verifier-bound source. Computing its DeckCommit and comparing to the
//      on-chain `deckCommitment` detects a data-availability grief in
//      milliseconds — BEFORE a wasted ~20 s Groth16 proof and a doomed tx that
//      would (worse) get the innocent agent slashed for "boycott".
//
//   2. poker_report_shuffle_da_fault — decide whether a fault is real before
//      encoding a reportShuffleDAFault tx the contract would reject.
//
// The circuit hashes the deck as a two-level Poseidon tree:
//   flat   — card-major [c1[i].x, c1[i].y, c2[i].x, c2[i].y] for i in 0..51
//   level0 — 13 chunks of 16 field elements → 13 chunk roots
//   level1 — Poseidon of the 13 chunk roots → the deck commitment
//
// circomlibjs `poseidon(inputs)` is the reference implementation of circomlib's
// `Poseidon(n)` template, which is `PoseidonEx(n,1)` with `initialState <== 0`
// reading `out[0]` — exactly what `DeckCommit` instantiates. Verified against
// the circuit's own fixture (deck_commit_n52_public.json) — bit-identical.

import { buildPoseidon, type Poseidon } from "circomlibjs";
import type { Point } from "./shuffle-input.js";

export const DECK_SIZE = 52;
const RATE = 16; // widest circomlib Poseidon arity — matches DeckCommit's RATE.

// audit 2026-05-22 MC-21 / Tema 9 — eski `Poseidon | null` cache iki paralel
// `await getPoseidon()` çağrısının her ikisinin de null-check'i geçip
// `buildPoseidon()`'u iki kez tetiklemesine yol açıyordu (gereksiz hesaplama,
// veri bozulması yok çünkü deterministic). Promise-singleton ile race kapalı:
// ilk çağrı promise'i kilitler, ikinci çağrı aynı promise'i await eder.
let cachedPoseidon: Promise<Poseidon> | null = null;
function getPoseidon(): Promise<Poseidon> {
  cachedPoseidon ??= buildPoseidon();
  return cachedPoseidon;
}

/**
 * Compute the Poseidon deck commitment of an encrypted N=52 deck — the exact
 * field element the shuffle circuits expose as `outputCommit` / `inputCommit`
 * and the contract chains with a plain equality.
 *
 * @returns the commitment as a decimal-string bigint (uint256-compatible).
 */
export async function deckCommitPoseidon(c1: Point[], c2: Point[]): Promise<bigint> {
  if (c1.length !== DECK_SIZE || c2.length !== DECK_SIZE) {
    throw new Error(
      `deckCommitPoseidon: expected ${DECK_SIZE}-card c1/c2, got ${c1.length}/${c2.length}`,
    );
  }
  const poseidon = await getPoseidon();

  // Card-major flatten — MUST match deck_commit.circom's `flat[4*i + ...]`.
  const flat: bigint[] = [];
  for (let i = 0; i < DECK_SIZE; i++) {
    flat.push(c1[i][0], c1[i][1], c2[i][0], c2[i][1]);
  }
  const total = flat.length; // 208 for N=52
  const chunks = Math.ceil(total / RATE); // 13 for N=52 (exact, no padding)

  // Level 0 — hash each 16-element chunk (zero-pad the tail, as the circuit
  // does; for N=52, 208 = 13*16 so no padding actually engages).
  const chunkRoots: bigint[] = [];
  for (let c = 0; c < chunks; c++) {
    const ins: bigint[] = [];
    for (let j = 0; j < RATE; j++) {
      const idx = c * RATE + j;
      ins.push(idx < total ? flat[idx] : 0n);
    }
    chunkRoots.push(BigInt(poseidon.F.toString(poseidon(ins))));
  }

  // Level 1 — hash the chunk roots into one deck commitment.
  return BigInt(poseidon.F.toString(poseidon(chunkRoots)));
}

/**
 * snarkjs witness input for the `deck_commit_n52` circuit (`DeckCommit(52)`).
 * The circuit's only inputs are the deck ciphertexts; `out` is computed.
 */
export type DeckCommitWitness = {
  c1: [string, string][];
  c2: [string, string][];
};

/** Format an encrypted deck as the deck_commit circuit's witness input. */
export function buildDeckCommitWitness(c1: Point[], c2: Point[]): DeckCommitWitness {
  if (c1.length !== DECK_SIZE || c2.length !== DECK_SIZE) {
    throw new Error(
      `buildDeckCommitWitness: expected ${DECK_SIZE}-card c1/c2, got ${c1.length}/${c2.length}`,
    );
  }
  const fmt = (pts: Point[]): [string, string][] =>
    pts.map((p) => [p[0].toString(), p[1].toString()]);
  return { c1: fmt(c1), c2: fmt(c2) };
}
