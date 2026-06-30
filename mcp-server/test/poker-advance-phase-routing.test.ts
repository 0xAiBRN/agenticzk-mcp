// poker-advance-phase-routing.test.ts — FIX-B (Path B build adversarial-review,
// 2026-06-22).
//
// Adversarial-review HIGH: poker_advance_phase only routed through the
// HandFlowRouter when the NEXT phase was a betting round, so River → Showdown
// (nextPhase == Showdown) fell through to a BARE TableSystem.advancePhase — which
// is onlyAuthorizedSystem and reverts NotAuthorized for a plain EOA → Path B
// bricked at showdown. The fix: when the router is configured, ALWAYS route every
// transition (including River → Showdown) through HandFlowRouter.advancePhaseAndInitRound.
// The router internally skips initRound at Showdown, so it is safe.
//
// These assert the pure routing helper buildAdvanceUnsignedTxs (exported from the
// tool) — no live chain needed.

import "./_env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAdvanceUnsignedTxs } from "../src/tools/poker_advance_phase.js";

const TID = ("0x" + "11".repeat(32)) as `0x${string}`;
const ROUTER = "0x00000000000000000000000000000000000000ff" as `0x${string}`;
const TABLE = "0x0000000000000000000000000000000000000a02";
const BET = "0x0000000000000000000000000000000000000a03";
const CHAIN = 5042002;

// Verified selectors (cast sig):
const SEL_ROUTER_ADVANCE = "0x38cbacd1"; // advancePhaseAndInitRound(bytes32)
const SEL_BARE_ADVANCE = "0xfd339642"; // advancePhase(bytes32) — EOA-reverting

test("FIX-B: River → Showdown routes to HandFlowRouter selector, NOT bare TableSystem.advancePhase", () => {
  const txs = buildAdvanceUnsignedTxs({
    tableId: TID,
    fromLabel: "River",
    toLabel: "Showdown",
    isBettingRoundNext: false, // Showdown is NOT a betting round
    router: ROUTER,
    tableSystem: TABLE,
    betSystem: BET,
    arcChainId: CHAIN,
  });
  assert.equal(txs.length, 1, "router path emits a single routed tx");
  assert.equal(txs[0].to, ROUTER, "tx targets the HandFlowRouter, not TableSystem");
  assert.equal(txs[0].data.slice(0, 10), SEL_ROUTER_ADVANCE);
  assert.notEqual(txs[0].data.slice(0, 10), SEL_BARE_ADVANCE);
  assert.equal(txs[0].value, "0");
  assert.equal(txs[0].chainId, CHAIN);
});

test("FIX-B: betting-round transitions also route through the router (single atomic tx)", () => {
  for (const toLabel of ["Flop", "Turn", "River"]) {
    const txs = buildAdvanceUnsignedTxs({
      tableId: TID,
      fromLabel: "X",
      toLabel,
      isBettingRoundNext: true,
      router: ROUTER,
      tableSystem: TABLE,
      betSystem: BET,
      arcChainId: CHAIN,
    });
    assert.equal(txs.length, 1, `${toLabel}: router path is a single tx`);
    assert.equal(txs[0].to, ROUTER);
    assert.equal(txs[0].data.slice(0, 10), SEL_ROUTER_ADVANCE);
  }
});

test("fallback (router unset): bare TableSystem.advancePhase for Showdown (no initRound)", () => {
  const txs = buildAdvanceUnsignedTxs({
    tableId: TID,
    fromLabel: "River",
    toLabel: "Showdown",
    isBettingRoundNext: false,
    router: undefined,
    tableSystem: TABLE,
    betSystem: BET,
    arcChainId: CHAIN,
  });
  assert.equal(txs.length, 1, "Showdown fallback: advancePhase only (no initRound)");
  assert.equal(txs[0].to, TABLE);
  assert.equal(txs[0].data.slice(0, 10), SEL_BARE_ADVANCE);
});

test("fallback (router unset): bare advancePhase + BetSystem.initRound for a betting round", () => {
  const txs = buildAdvanceUnsignedTxs({
    tableId: TID,
    fromLabel: "Preflop",
    toLabel: "Flop",
    isBettingRoundNext: true,
    router: undefined,
    tableSystem: TABLE,
    betSystem: BET,
    arcChainId: CHAIN,
  });
  assert.equal(txs.length, 2, "betting-round fallback: advancePhase + initRound");
  assert.equal(txs[0].to, TABLE);
  assert.equal(txs[0].data.slice(0, 10), SEL_BARE_ADVANCE);
  assert.equal(txs[1].to, BET);
});
