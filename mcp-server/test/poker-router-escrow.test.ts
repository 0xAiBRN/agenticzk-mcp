// poker-router-escrow.test.ts — FIX-4 (Path B build, 2026-06-22).
//
// 5 new PK-safe unsignedTx wrappers: poker_start_hand + poker_reset_crypto
// (HandFlowRouter) and poker_cancel / poker_cancel_if_underseated /
// poker_abandon_settlement (Orchestrator escrow recovery). The dead
// poker_finalize_tournament tool is deleted (covered by build: a dangling import
// would fail tsc). Same offline-deterministic pattern as poker-expire.test.ts.

import "./_env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pokerStartHandHandler } from "../src/tools/poker_start_hand.js";
import { pokerResetCryptoHandler } from "../src/tools/poker_reset_crypto.js";
import { pokerCancelHandler } from "../src/tools/poker_cancel.js";
import { pokerCancelIfUnderseatedHandler } from "../src/tools/poker_cancel_if_underseated.js";
import { pokerAbandonSettlementHandler } from "../src/tools/poker_abandon_settlement.js";

const TID = "0x" + "11".repeat(32);

function unwrapErr(r: { isError?: boolean; content: { text: string }[] }) {
  assert.equal(r.isError, true, "expected error result");
  return JSON.parse(r.content[0].text);
}
function unwrapOk(r: { isError?: boolean; content: { text: string }[] }) {
  if (r.isError) throw new Error(`expected ok result, got error: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
}

// ── id validation (before any RPC) ─────────────────────────────────────────
for (const [name, handler] of [
  ["poker_start_hand", pokerStartHandHandler],
  ["poker_reset_crypto", pokerResetCryptoHandler],
] as const) {
  test(`${name}: rejects malformed tableId`, async () => {
    const r = await handler({ tableId: "0x1234" });
    const body = unwrapErr(r);
    // E_INVALID_TABLE_ID (router set) or E_NO_ROUTER (router unset) — both mean
    // the bad id did not produce a tx.
    assert.ok(body.code === "E_INVALID_TABLE_ID" || body.code === "E_NO_ROUTER", `got ${body.code}`);
  });
}

for (const [name, handler] of [
  ["poker_cancel", pokerCancelHandler],
  ["poker_cancel_if_underseated", pokerCancelIfUnderseatedHandler],
  ["poker_abandon_settlement", pokerAbandonSettlementHandler],
] as const) {
  test(`${name}: rejects malformed tournamentId`, async () => {
    const r = await handler({ tournamentId: "0x1234" });
    assert.equal(unwrapErr(r).code, "E_INVALID_TOURNAMENT_ID");
  });
}

// ── cancel family: pure encode → deterministic unsignedTx + selector ───────
for (const [name, handler, selector] of [
  ["poker_cancel", pokerCancelHandler, "0xc4d252f5"],
  ["poker_cancel_if_underseated", pokerCancelIfUnderseatedHandler, "0xe12b103e"],
  ["poker_abandon_settlement", pokerAbandonSettlementHandler, "0x9a3dd148"],
] as const) {
  test(`${name}: encodes the verified selector ${selector}`, async () => {
    const body = unwrapOk(await handler({ tournamentId: TID }));
    assert.equal(typeof body.unsignedTx?.to, "string");
    assert.equal(body.unsignedTx.value, "0");
    assert.equal(body.unsignedTx.data.slice(0, 10), selector);
  });
}

// ── router tools: well-formed tableId passes validation (tolerant) ─────────
for (const [name, handler, selector] of [
  ["poker_start_hand", pokerStartHandHandler, "0xb15465ff"],
  ["poker_reset_crypto", pokerResetCryptoHandler, "0x097dbb8d"],
] as const) {
  test(`${name}: well-formed tableId does not fail validation`, async () => {
    const r = await handler({ tableId: TID });
    if (r.isError) {
      const body = unwrapErr(r);
      assert.notEqual(body.code, "E_INVALID_TABLE_ID");
      // E_NO_ROUTER (unset) or E_DEAL_NOT_READY (start_hand preflight) are fine.
    } else {
      const body = unwrapOk(r);
      assert.equal(body.unsignedTx.value, "0");
      assert.equal(body.unsignedTx.data.slice(0, 10), selector);
    }
  });
}
