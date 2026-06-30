// poker-hole-status.test.ts — FIX-C (Path B build adversarial-review, 2026-06-22).
//
// poker_hole_status is the HOLE-card counterpart to poker_round_status: a pure
// read tool that tells a Path-B harness which hole cardIdxs it owes a non-owner
// share for + which two cards are its own. With the dummy test orchestrator every
// on-chain read fails / returns nothing → the handler must fail closed (no tx, no
// crash) rather than emit bogus obligations.
//
// PK-safety: this tool encodes NOTHING. The only assertions are validation +
// safe-default behavior — same offline-deterministic style as the other read
// tool tests (no live RPC).

import "./_env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { pokerHoleStatusHandler } from "../src/tools/poker_hole_status.js";
import { PokerDecryptAbi } from "../src/poker-abis.js";

const TID = "0x" + "11".repeat(32);
const PLAYER = "0x1234567890123456789012345678901234567890";

function unwrapErr(r: { isError?: boolean; content: { text: string }[] }) {
  assert.equal(r.isError, true, "expected error result");
  return JSON.parse(r.content[0].text);
}
function unwrapOk(r: { isError?: boolean; content: { text: string }[] }) {
  if (r.isError) throw new Error(`expected ok result, got error: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
}

// ── input validation (before any RPC) ──────────────────────────────────────
test("poker_hole_status: rejects malformed tableId", async () => {
  const r = await pokerHoleStatusHandler({ tableId: "0x1234", player: PLAYER });
  assert.equal(unwrapErr(r).code, "E_INVALID_TABLE_ID");
});

test("poker_hole_status: rejects malformed player address", async () => {
  const r = await pokerHoleStatusHandler({ tableId: TID, player: "0xdead" });
  assert.equal(unwrapErr(r).code, "E_INVALID_PLAYER");
});

test("poker_hole_status: rejects empty player", async () => {
  const r = await pokerHoleStatusHandler({ tableId: TID, player: "" });
  assert.equal(unwrapErr(r).code, "E_INVALID_PLAYER");
});

// ── safe-defaults on read failure (dummy orchestrator → handRoster read fails
//    or returns empty) ───────────────────────────────────────────────────────
test("poker_hole_status: read failure / empty roster never fabricates obligations", async () => {
  const r = await pokerHoleStatusHandler({ tableId: TID, player: PLAYER });
  if (r.isError) {
    // handRoster RPC failed → E_READ_FAILED, no tx, no crash. Acceptable fail-closed.
    const body = unwrapErr(r);
    assert.ok(
      body.code === "E_READ_FAILED" || body.code === "E_DECRYPT_READ",
      `unexpected error code ${body.code}`,
    );
  } else {
    // handRoster returned empty (N=0) → empty hole set, never invents an obligation.
    const body = unwrapOk(r);
    assert.equal(body.handRosterCount, 0);
    assert.deepEqual(body.cards, []);
    assert.deepEqual(body.iOwe, []);
    assert.deepEqual(body.myCardIdxs, []);
  }
});

// ── ABI sanity: the getters the tool relies on are present + match their
//    verified selectors (so a future ABI edit cannot silently break the reads) ─
for (const [sig, fn, selector] of [
  ["holeOwnerOf(bytes32,uint8)", "holeOwnerOf", "0x94ae8046"],
  ["requiredSharesFor(bytes32,uint8)", "requiredSharesFor", "0xce054219"],
  ["shareCount(bytes32,uint8)", "shareCount", "0x786abe52"],
  ["revealed(bytes32,uint8)", "revealed", "0x518343fb"],
  ["ownerShareSubmitted(bytes32,uint8)", "ownerShareSubmitted", "0x7dc4c0a5"],
] as const) {
  test(`PokerDecryptAbi.${fn} encodes verified selector ${selector} (${sig})`, () => {
    const data = encodeFunctionData({
      abi: PokerDecryptAbi,
      functionName: fn,
      args: [TID, 0],
    });
    assert.equal(data.slice(0, 10), selector);
  });
}
