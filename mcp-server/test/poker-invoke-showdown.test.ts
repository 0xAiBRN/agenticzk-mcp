// 2026-05-24 — Codex mainnet readiness item 3 B-2: poker_invoke_showdown
// pure-validation testleri. Tool tableId malformasyonunu RPC'ye gitmeden
// önce yakalar; happy path + phase pre-check RPC mock gerektirir (canlı
// integration smoke kapsamında doğrulanır).

import "./_env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pokerInvokeShowdownHandler,
  computeShowdownMissingShares,
} from "../src/tools/poker_invoke_showdown.js";

const TID = "0x" + "22".repeat(32);

function unwrapErr(r: { isError?: boolean; content: { text: string }[] }) {
  assert.equal(r.isError, true, "expected error result");
  return JSON.parse(r.content[0].text);
}

test("invoke_showdown rejects missing tableId", async () => {
  const r = await pokerInvokeShowdownHandler({ tableId: "" });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_INVALID_TABLE_ID");
});

test("invoke_showdown rejects short tableId", async () => {
  const r = await pokerInvokeShowdownHandler({ tableId: "0x1234" });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_INVALID_TABLE_ID");
});

test("invoke_showdown rejects non-0x tableId", async () => {
  const r = await pokerInvokeShowdownHandler({
    tableId: "22".repeat(32),
  });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_INVALID_TABLE_ID");
});

test("invoke_showdown surfaces read failure as E_READ_FAILED (RPC unreachable in unit env)", async () => {
  // _env.ts'deki placeholder POKER_TABLE_SYSTEM gerçek bir kontrat değil;
  // RPC'ye getTable çağrısı düşer ve handler bunu E_READ_FAILED'a wrap eder.
  // Phase check'ine ulaşmadan dönmeli — bu da pre-check sırasının doğru
  // olduğunu kanıtlar (tableId valid → RPC dene → fail).
  const r = await pokerInvokeShowdownHandler({ tableId: TID });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_READ_FAILED");
});

// ── B1 forfeit-skip preflight (Codex 2026-06-04) ─────────────────────────────
// 4-handed: hole cards 0..7 (seat i = cards i and i+4); community [9,10,11,13,15].
const N = 4;
const HOLE = [0, 1, 2, 3, 4, 5, 6, 7];
const COMM = [9, 10, 11, 13, 15];
// per hole card: [shareCount, ownerShareSubmitted, ownerShareForfeited]
function holeAll(): [number, boolean, boolean][] {
  return HOLE.map(() => [3, true, false] as [number, boolean, boolean]);
}
// per community card: [shareCount, revealed]
function commAll(): [number, boolean][] {
  return COMM.map(() => [4, true] as [number, boolean]);
}
function compute(
  holeReads: [number, boolean, boolean][],
  communityReads: [number, boolean][] = commAll(),
) {
  return computeShowdownMissingShares({ N, holeIdxs: HOLE, communityIdxs: COMM, holeReads, communityReads });
}

test("preflight: all shares complete + no forfeit → no gaps", () => {
  assert.deepEqual(compute(holeAll()), []);
});

test("preflight: a genuinely un-submitted hole card (not forfeited) → reported gap", () => {
  const h = holeAll();
  h[2] = [3, false, false]; // card 2: owner share missing, NOT forfeited
  const missing = compute(h);
  assert.equal(missing.length, 1);
  assert.deepEqual(missing[0], { cardIdx: 2, role: "hole", reason: "ownerShareSubmitted=false" });
});

test("B1: a FORFEITED seat is SKIPPED, not reported — even with shareCount short + owner unsubmitted", () => {
  // The absent-owner liveness rail: expireOwnerShare forfeited seat 0 (card 0).
  // Card 0 has NO non-owner shares and NO owner share, but the seat is a forced
  // fold → must NOT block invokeShowdown. Pre-fix this returned a gap → deadlock.
  const h = holeAll();
  h[0] = [0, false, true]; // card 0 forfeited, fully empty
  assert.deepEqual(compute(h), []);
});

test("B1 sibling rule: forfeiting one hole card of a seat also skips its sibling (cardIdx±N)", () => {
  // Seat 0 = cards 0 and 4. Forfeit card 0; card 4 has gaps but belongs to the
  // same (folded) seat → both skipped.
  const h = holeAll();
  h[0] = [0, false, true]; // card 0 forfeited
  h[4] = [1, false, false]; // sibling card 4 has gaps but NOT independently forfeited
  assert.deepEqual(compute(h), [], "the forfeited seat's sibling must also be skipped");
});

test("B1: forfeit one seat but ANOTHER seat genuinely missing → only the genuine gap reported", () => {
  const h = holeAll();
  h[0] = [0, false, true]; // seat 0 forfeited (skip)
  h[4] = [0, false, false]; // seat 0 sibling (skip via sibling rule)
  h[1] = [3, false, false]; // seat 1: owner share genuinely missing → MUST report
  const missing = compute(h);
  assert.equal(missing.length, 1);
  assert.deepEqual(missing[0], { cardIdx: 1, role: "hole", reason: "ownerShareSubmitted=false" });
});

test("preflight: an unrevealed community card → reported gap", () => {
  const c = commAll();
  c[3] = [2, false]; // community idx 13 not revealed
  const missing = compute(holeAll(), c);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].role, "community");
  assert.equal(missing[0].cardIdx, 13);
});

test("preflight: non-owner share short (not forfeited) → reported gap", () => {
  const h = holeAll();
  h[5] = [2, true, false]; // card 5: shareCount 2/3
  const missing = compute(h);
  assert.equal(missing.length, 1);
  assert.deepEqual(missing[0], { cardIdx: 5, role: "hole", reason: "shareCount=2/3" });
});
