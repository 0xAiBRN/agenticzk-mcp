// ZK Shuffle Gas milestone (2026-05-21) — off-chain DeckCommit test harness.
//
// `deckCommitPoseidon` re-implements the `DeckCommit(52)` circuit in JS so the
// MCP can detect a data-availability grief in milliseconds (poker_shuffle_prove
// E_SHUFFLE_DA_GRIEF) and decide whether a reportShuffleDAFault tx is real
// (poker_report_shuffle_da_fault E_NO_DA_FAULT). If the JS hash drifts from the
// circuit, the MCP would either frame an honest round or miss a guilty one —
// so the strongest test cross-checks it against the circuit's own fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  deckCommitPoseidon,
  buildDeckCommitWitness,
  DECK_SIZE,
} from "../src/zk/deck-commit.js";
import type { Point } from "../src/zk/shuffle-input.js";

// BN254 scalar field — every Poseidon output must be a canonical element.
const BN254_FR =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Tiny deterministic deck — distinct, in-field coordinates. */
function syntheticDeck(salt: bigint): { c1: Point[]; c2: Point[] } {
  const c1: Point[] = [];
  const c2: Point[] = [];
  for (let i = 0; i < DECK_SIZE; i++) {
    const b = salt + BigInt(i);
    c1.push([(b * 7n + 1n) % BN254_FR, (b * 13n + 2n) % BN254_FR]);
    c2.push([(b * 17n + 3n) % BN254_FR, (b * 19n + 4n) % BN254_FR]);
  }
  return { c1, c2 };
}

test("deckCommitPoseidon yields a canonical BN254 field element", async () => {
  const d = syntheticDeck(100n);
  const commit = await deckCommitPoseidon(d.c1, d.c2);
  assert.ok(commit > 0n, "commitment is non-zero");
  assert.ok(commit < BN254_FR, "commitment is reduced mod the BN254 scalar field");
});

test("deckCommitPoseidon is deterministic — same deck → same commitment", async () => {
  const d = syntheticDeck(42n);
  const a = await deckCommitPoseidon(d.c1, d.c2);
  const b = await deckCommitPoseidon(d.c1, d.c2);
  assert.equal(a, b);
});

test("a single mutated coordinate changes the commitment (binding)", async () => {
  const d = syntheticDeck(7n);
  const honest = await deckCommitPoseidon(d.c1, d.c2);
  // Flip one bit of card 0's c1.x.
  const tampered = d.c1.map((p, i) => (i === 0 ? [p[0] ^ 1n, p[1]] as Point : p));
  const forged = await deckCommitPoseidon(tampered, d.c2);
  assert.notEqual(forged, honest);
});

test("swapping two cards changes the commitment (card-major ordering)", async () => {
  const d = syntheticDeck(9n);
  const honest = await deckCommitPoseidon(d.c1, d.c2);
  // Swap card 0 and card 1 in c2 only — a permutation the commitment must see.
  const swapped = d.c2.map((p, i) => (i === 0 ? d.c2[1] : i === 1 ? d.c2[0] : p));
  const reordered = await deckCommitPoseidon(d.c1, swapped);
  assert.notEqual(reordered, honest);
});

test("deckCommitPoseidon rejects a wrong-length deck", async () => {
  await assert.rejects(() => deckCommitPoseidon([], []));
});

test("buildDeckCommitWitness shapes a 52-card decimal-string witness", () => {
  const d = syntheticDeck(1n);
  const w = buildDeckCommitWitness(d.c1, d.c2);
  assert.equal(w.c1.length, DECK_SIZE);
  assert.equal(w.c2.length, DECK_SIZE);
  assert.equal(w.c1[0].length, 2);
  assert.equal(typeof w.c1[0][0], "string");
  assert.equal(w.c1[3][1], d.c1[3][1].toString());
  assert.throws(() => buildDeckCommitWitness([], []));
});

// Gold-standard cross-check: the JS hash MUST equal the `deck_commit_n52`
// circuit's own public output. JS↔circuit drift bir grief'i kaçırmak veya
// dürüst bir round'u suçlu göstermek demek — bu test mainnet öncesi tek
// gerçek garanti.
//
// audit 2026-05-22 Tema 5 — eski versiyon ZK_ARTIFACTS_DIR yoksa `t.skip()`
// ile sessizce geçiyordu (CI'da false-green: pnpm test PASS ama kritik
// assertion hiç koşmuyor). Düzeltme: fixture artık `test/fixtures/`'a
// commit'li → temiz CI clone'da koşulsuz koşar. `ZK_ARTIFACTS_DIR` set'liyse
// fresh build override eder (geliştirici workflow).
test("deckCommitPoseidon matches the deck_commit circuit fixture", async () => {
  const fixturesDir = path.join(import.meta.dirname, "fixtures");
  const dir = process.env.ZK_ARTIFACTS_DIR ?? fixturesDir;
  const inputPath = path.join(dir, "deck_commit_n52_input.json");
  const publicPath = path.join(dir, "deck_commit_n52_public.json");
  if (!existsSync(inputPath) || !existsSync(publicPath)) {
    throw new Error(
      `deck_commit fixture missing: ${inputPath} (set ZK_ARTIFACTS_DIR or commit fixture under test/fixtures/)`,
    );
  }
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as {
    c1: [string, string][];
    c2: [string, string][];
  };
  const pub = JSON.parse(readFileSync(publicPath, "utf8")) as string[];
  const c1: Point[] = input.c1.map((p) => [BigInt(p[0]), BigInt(p[1])]);
  const c2: Point[] = input.c2.map((p) => [BigInt(p[0]), BigInt(p[1])]);
  const computed = await deckCommitPoseidon(c1, c2);
  // deck_commit public-signal layout: [out, c1(104), c2(104)] → pub[0] = out.
  assert.equal(computed.toString(), pub[0], "off-chain DeckCommit must equal circuit `out`");
});
