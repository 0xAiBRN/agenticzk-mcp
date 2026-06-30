// poker-register-with-auth.test.ts — FIX-1 (Path B build, 2026-06-22).
//
// Covers the two FIX-1 surfaces with the same offline-deterministic pattern as
// poker-expire.test.ts: the validation layer runs BEFORE any on-chain read, and
// the on-chain preflight reads are non-fatal (swallowed on RPC/decode failure),
// so no live chain is required. The live happy path is covered by the Path-B
// end-to-end proof (register-eip3009.ts → AgentRegistered).
//
//   (A) poker_register_with_authorization — recipe + PK-safety (NO v/r/s, NO calldata).
//   (B) poker_register_for_tournament — fail-closed public-USDC gate (refuses,
//       emits ZERO unsignedTxs, so a naive user cannot strand the entry fee).

import "./_env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { pokerRegisterWithAuthorizationHandler } from "../src/tools/poker_register_with_authorization.js";
import { pokerRegisterForTournamentHandler } from "../src/tools/poker_register_for_tournament.js";
import { PokerOrchestratorAbi } from "../src/poker-abis.js";

const TID = "0x" + "11".repeat(32);
const PLAYER = "0x" + "22".repeat(20);

function unwrapErr(r: { isError?: boolean; content: { text: string }[] }) {
  assert.equal(r.isError, true, "expected error result");
  return JSON.parse(r.content[0].text);
}
function unwrapOk(r: { isError?: boolean; content: { text: string }[] }) {
  if (r.isError) throw new Error(`expected ok result, got error: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
}

// ── ABI selector roundtrip (locks the FIX-1 fragments) ─────────────────────
test("registerWithAuthorization encodes to selector 0xb704dd06", () => {
  const data = encodeFunctionData({
    abi: PokerOrchestratorAbi,
    functionName: "registerWithAuthorization",
    args: [TID, 1n, 1_000_000n, 0n, 9_999_999_999n, ("0x" + "00".repeat(32)) as `0x${string}`, 27, ("0x" + "00".repeat(32)) as `0x${string}`, ("0x" + "00".repeat(32)) as `0x${string}`],
  });
  assert.equal(data.slice(0, 10), "0xb704dd06");
});
test("isPublicUsdcOnly encodes to selector 0x8d2c61fa", () => {
  const data = encodeFunctionData({ abi: PokerOrchestratorAbi, functionName: "isPublicUsdcOnly", args: [] });
  assert.equal(data.slice(0, 10), "0x8d2c61fa");
});

// ── (A) poker_register_with_authorization — validation ─────────────────────
test("register_with_auth: rejects malformed player address", async () => {
  const r = await pokerRegisterWithAuthorizationHandler({ player: "nope", tournamentId: TID, agentId: "1" });
  assert.equal(unwrapErr(r).code, "E_INVALID_ADDRESS");
});
test("register_with_auth: rejects malformed tournamentId", async () => {
  const r = await pokerRegisterWithAuthorizationHandler({ player: PLAYER, tournamentId: "0x1234", agentId: "1" });
  assert.equal(unwrapErr(r).code, "E_INVALID_TOURNAMENT_ID");
});
test("register_with_auth: rejects non-numeric agentId", async () => {
  const r = await pokerRegisterWithAuthorizationHandler({ player: PLAYER, tournamentId: TID, agentId: "abc" });
  assert.equal(unwrapErr(r).code, "E_INVALID_AGENT_ID");
});
test("register_with_auth: rejects zero/negative agentId", async () => {
  const r = await pokerRegisterWithAuthorizationHandler({ player: PLAYER, tournamentId: TID, agentId: "0" });
  assert.equal(unwrapErr(r).code, "E_INVALID_AGENT_ID");
});

// ── (A) PK-SAFETY — the recipe carries NO signature and NO calldata ────────
test("register_with_auth: well-formed returns a PK-safe recipe (no v/r/s, no calldata)", async () => {
  // With the dummy test orchestrator the preflight reads fail non-fatally and
  // the handler returns the recipe. (On a real RPC it may instead return a
  // preflight error like E_WRONG_PHASE — both prove validation passed.)
  const r = await pokerRegisterWithAuthorizationHandler({ player: PLAYER, tournamentId: TID, agentId: "1" });
  if (r.isError) {
    const body = unwrapErr(r);
    assert.notEqual(body.code, "E_INVALID_ADDRESS");
    assert.notEqual(body.code, "E_INVALID_TOURNAMENT_ID");
    assert.notEqual(body.code, "E_INVALID_AGENT_ID");
    return;
  }
  const body = unwrapOk(r);
  // No transaction signature anywhere (the MCP never signs).
  assert.equal(body.v, undefined);
  assert.equal(body.r, undefined);
  assert.equal(body.s, undefined);
  assert.equal(body.unsignedTx, undefined, "must NOT return an unsignedTx — calldata needs the EIP-3009 sig");
  assert.equal(body.register?.data, undefined, "recipe must not contain final calldata");
  assert.equal(body.register?.v, undefined);
  // It IS a usable recipe.
  assert.equal(body.register?.functionName, "registerWithAuthorization");
  assert.ok(Array.isArray(body.register?.argsOrder));
  assert.ok(body.signer?.howTo?.includes("register-eip3009"));
});

// ── (B) Fail-closed public-USDC gate on the legacy tool ────────────────────
test("register_for_tournament: gate refuses + emits ZERO unsignedTxs", async () => {
  // The dummy test orchestrator is not a real contract, so isPublicUsdcOnly()
  // read fails → fail-closed E_GATE_READ_FAILED. Against the live public
  // orchestrator it would be E_DEPOSITFOR_DISABLED. Either proves the gate
  // fires BEFORE building the strand-the-funds 3-step chain.
  const r = await pokerRegisterForTournamentHandler({ player: PLAYER, tournamentId: TID, agentId: "1" });
  const body = unwrapErr(r);
  assert.ok(
    body.code === "E_DEPOSITFOR_DISABLED" || body.code === "E_GATE_READ_FAILED",
    `expected gate error, got ${body.code}`,
  );
  // Critically: no transaction list reached the user (nothing to sign → nothing strands).
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.unsignedTxs, undefined);
});
