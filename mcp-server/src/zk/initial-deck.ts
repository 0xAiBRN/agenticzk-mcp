// Shared canonical initial-deck builder + commitment — single source of truth.
//
// F-03 (Codex pre-mainnet readiness audit, 2026-05-20): the initial 52-card
// deck is ElGamal-encrypted, so it cannot be plaintext-checked on-chain. But it
// is *fully deterministic* given the joint pk. `poker_hand_start` seeds it and
// `poker_shuffle_prove` verifies it against `DealSystem.deckCommitmentOf` — both
// MUST build the deck identically, so the logic lives here once.

import { buildBabyjub } from "circomlibjs";
import { keccak256, encodeAbiParameters } from "viem";
import type { Point } from "./shuffle-input.js";

export const DECK_SIZE = 52;

// Public, deterministic per-card randomness base. These values are public — the
// first agent's shuffle re-encrypts every card, so cryptographic strength here
// is irrelevant; only per-card distinctness and a canonical m_i <-> card index
// mapping matter. Changing this constant changes the canonical deck definition
// and MUST stay in lockstep across every party.
const BASE_R = 11111111111111111111111111111111111111111111111n;

/**
 * Build the canonical initial deck under `jointPk`:
 *   c1[i] = r_i · G
 *   c2[i] = (i+1) · G + r_i · jointPk
 * with deterministic but distinct r_i (so c1[i] never collides — a degenerate
 * shuffle witness input). Fully determined by `jointPk`: any party can
 * recompute this and compare to the on-chain commitment.
 */
export async function buildInitialDeck(
  jointPk: Point,
): Promise<{ c1: Point[]; c2: Point[] }> {
  const bj = await buildBabyjub();
  const G = bj.Base8;
  const pkF: [Uint8Array, Uint8Array] = [bj.F.e(jointPk[0]), bj.F.e(jointPk[1])];

  const c1Raw: [Uint8Array, Uint8Array][] = [];
  const c2Raw: [Uint8Array, Uint8Array][] = [];
  for (let i = 0; i < DECK_SIZE; i++) {
    const r = (BASE_R + BigInt(i) * 17n) % bj.subOrder;
    const m = bj.mulPointEscalar(G, BigInt(i + 1));
    const rG = bj.mulPointEscalar(G, r);
    const rPk = bj.mulPointEscalar(pkF, r);
    c1Raw.push(rG as [Uint8Array, Uint8Array]);
    c2Raw.push(bj.addPoint(m, rPk) as [Uint8Array, Uint8Array]);
  }
  const toBig = (p: [Uint8Array, Uint8Array]): Point => [
    BigInt(bj.F.toString(p[0])),
    BigInt(bj.F.toString(p[1])),
  ];
  return { c1: c1Raw.map(toBig), c2: c2Raw.map(toBig) };
}

/**
 * F-03 — keccak256 commitment to a deck, byte-identical to the on-chain
 * `DealSystem.initDeal` computation: `keccak256(abi.encode(c1, c2))` where
 * both `c1` and `c2` are `uint256[2][52]`.
 */
export function deckCommitment(c1: Point[], c2: Point[]): `0x${string}` {
  if (c1.length !== DECK_SIZE || c2.length !== DECK_SIZE) {
    throw new Error(
      `deckCommitment: expected ${DECK_SIZE}-card c1/c2, got ${c1.length}/${c2.length}`,
    );
  }
  const toTuples = (pts: Point[]): readonly (readonly [bigint, bigint])[] =>
    pts.map((p) => [p[0], p[1]] as const);
  // viem types `uint256[2][52]` as a fixed 52-tuple; the length is guaranteed
  // by the DECK_SIZE check above, so the `as never` cast is sound at runtime.
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256[2][52]" }, { type: "uint256[2][52]" }],
      [toTuples(c1), toTuples(c2)] as never,
    ),
  );
}
