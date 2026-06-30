// F-12 (Codex pre-mainnet readiness audit, 2026-05-20) — test harness for the
// MCP ZK glue. Covers the F-03 canonical-deck commitment: it must be
// deterministic given the joint pk, and ANY deviation (different pk, a
// duplicated/tampered card) must change the hash so poker_shuffle_prove can
// reject a forged seed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInitialDeck, deckCommitment, DECK_SIZE } from "../src/zk/initial-deck.js";
import { deriveSessionKeypair } from "../src/zk/shuffle-input.js";

test("buildInitialDeck yields a full 52-card deck", async () => {
  const { pk } = await deriveSessionKeypair(777n);
  const deck = await buildInitialDeck(pk);
  assert.equal(deck.c1.length, DECK_SIZE);
  assert.equal(deck.c2.length, DECK_SIZE);
});

test("deckCommitment is deterministic — same jointPk → same hash", async () => {
  const { pk } = await deriveSessionKeypair(777n);
  const a = await buildInitialDeck(pk);
  const b = await buildInitialDeck(pk);
  assert.equal(deckCommitment(a.c1, a.c2), deckCommitment(b.c1, b.c2));
});

test("different jointPk → different commitment", async () => {
  const a = await deriveSessionKeypair(111n);
  const b = await deriveSessionKeypair(222n);
  const da = await buildInitialDeck(a.pk);
  const db = await buildInitialDeck(b.pk);
  assert.notEqual(deckCommitment(da.c1, da.c2), deckCommitment(db.c1, db.c2));
});

test("a tampered (duplicated) card changes the commitment — F-03 forged-deck detection", async () => {
  const { pk } = await deriveSessionKeypair(333n);
  const d = await buildInitialDeck(pk);
  const honest = deckCommitment(d.c1, d.c2);
  // Overwrite card slot 1 with card slot 0 → a non-canonical duplicate deck.
  const forgedC2 = d.c2.map((p, i) => (i === 1 ? d.c2[0] : p));
  assert.notEqual(deckCommitment(d.c1, forgedC2), honest);
});

test("deckCommitment rejects a wrong-length deck", () => {
  assert.throws(() => deckCommitment([], []));
});
