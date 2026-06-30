// poker-table-state-commitreveal.test.ts — FIX-5 (Path B build, 2026-06-22).
//
// poker_table_state now surfaces a commitReveal barrier sub-object so a Path-B
// harness can run commit→minBlock→reveal without out-of-band cast calls. With
// the dummy test orchestrator every on-chain read fails non-fatally → the
// handler returns safe defaults, which is exactly what we assert here.

import "./_env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { pokerTableStateHandler } from "../src/tools/poker_table_state.js";
import { PokerBetAbi } from "../src/poker-abis.js";

const TID = "0x" + "11".repeat(32);
const ZERO_HASH = "0x" + "00".repeat(32);
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function unwrapOk(r: { isError?: boolean; content: { text: string }[] }) {
  if (r.isError) throw new Error(`expected ok result, got error: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
}

test("pendingCommit encodes to selector 0x166244a7", () => {
  const data = encodeFunctionData({ abi: PokerBetAbi, functionName: "pendingCommit", args: [TID] });
  assert.equal(data.slice(0, 10), "0x166244a7");
});

test("table_state: rejects malformed tableId", async () => {
  const r = await pokerTableStateHandler({ tableId: "0x12" });
  assert.equal(r.isError, true);
  assert.equal(JSON.parse(r.content[0].text).code, "E_INVALID_TABLE_ID");
});

test("table_state: commitReveal present with safe defaults (reads non-fatal)", async () => {
  const body = unwrapOk(await pokerTableStateHandler({ tableId: TID }));
  assert.equal(typeof body.commitReveal, "object");
  assert.equal(body.commitReveal.enabled, false);
  assert.equal(body.commitReveal.pending, false);
  assert.equal(body.commitReveal.pendingCommitter, ZERO_ADDR);
  assert.equal(body.commitReveal.pendingCommitHash, ZERO_HASH);
  assert.equal(body.commitReveal.commitDeadline, "0");
  assert.equal(body.commitReveal.actionDeadline, "0");
  assert.equal(body.commitReveal.revealWindowSeconds, 60);
  // No minBlock passed → snapshot is NOT coherent (harness must pin before reveal).
  assert.equal(body.commitReveal.coherentSnapshot, false);
});

test("table_state: minBlock=0 keeps coherentSnapshot false", async () => {
  const body = unwrapOk(await pokerTableStateHandler({ tableId: TID, minBlock: "0" }));
  assert.equal(body.commitReveal.coherentSnapshot, false);
});
