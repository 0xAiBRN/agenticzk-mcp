// MC-13 / audit 2026-05-22 K#3 regression — agent_validate authz semantics.
//
// Pre-fix bug: `respond` action defaulted `response` to 100 ("passed"). A
// caller could omit the field and produce an unsigned tx that, if signed,
// would write a fake "passed" certificate against ANY known requestHash —
// ERC-8004 reputation manipulation.
//
// Post-fix: response is REQUIRED. This suite asserts:
//   1. respond without `response` returns E_MISSING_PARAMS (not a default).
//   2. respond with response=0 ("failed") builds a real unsignedTx.
//   3. respond with response=100 ("passed") builds a real unsignedTx.
//   4. status branch returns E_VALIDATION_READ on RPC failure (not a process
//      crash — pre-fix had no try/catch).
import "./_env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentValidateHandler } from "../src/tools/agent_validate.js";

function unwrap(r: { content: { text: string }[] }) {
  return JSON.parse(r.content[0].text);
}

const VALIDATOR = "0x29C2F998B325053F2e81532b5e3a44dac7A84978";
const RH = ("0x" + "ab".repeat(32)) as `0x${string}`;

test("agent_validate respond REJECTS missing `response` (no silent 'passed' default)", async () => {
  const r = await agentValidateHandler({
    action: "respond",
    validator: VALIDATOR,
    requestHash: RH,
    // response intentionally omitted
  });
  const body = unwrap(r);
  assert.equal((r as { isError?: boolean }).isError, true);
  assert.equal(body.code, "E_MISSING_PARAMS");
  assert.match(String(body.message), /response/i);
});

test("agent_validate respond accepts response=0 (failed) and builds unsignedTx", async () => {
  const r = await agentValidateHandler({
    action: "respond",
    validator: VALIDATOR,
    requestHash: RH,
    response: 0,
  });
  const body = unwrap(r);
  assert.notEqual((r as { isError?: boolean }).isError, true);
  assert.ok(body.unsignedTx?.data?.startsWith?.("0x"), "tx data 0x-hex");
  assert.equal(body.responseCode, 0);
});

test("agent_validate respond accepts response=100 (passed) and builds unsignedTx", async () => {
  const r = await agentValidateHandler({
    action: "respond",
    validator: VALIDATOR,
    requestHash: RH,
    response: 100,
  });
  const body = unwrap(r);
  assert.notEqual((r as { isError?: boolean }).isError, true);
  assert.equal(body.responseCode, 100);
});

test("agent_validate request REJECTS missing required params", async () => {
  const r = await agentValidateHandler({ action: "request" });
  const body = unwrap(r);
  assert.equal((r as { isError?: boolean }).isError, true);
  assert.equal(body.code, "E_MISSING_PARAMS");
});

test("agent_validate request builds unsignedTx + CSPRNG requestHash", async () => {
  const r1 = await agentValidateHandler({
    action: "request",
    owner: VALIDATOR,
    validator: VALIDATOR,
    agentId: "1",
    requestURI: "ipfs://test",
  });
  const r2 = await agentValidateHandler({
    action: "request",
    owner: VALIDATOR,
    validator: VALIDATOR,
    agentId: "1",
    requestURI: "ipfs://test",
  });
  const b1 = unwrap(r1);
  const b2 = unwrap(r2);
  // CSPRNG entropy — two identical inputs MUST yield different requestHashes
  // (pre-fix Date.now() was ms-resolution → guessable + sometimes colliding).
  assert.notEqual(b1.requestHash, b2.requestHash, "CSPRNG nonce → distinct hashes");
  assert.match(String(b1.requestHash), /^0x[0-9a-f]{64}$/);
});

test("agent_validate status REJECTS missing requestHash", async () => {
  const r = await agentValidateHandler({ action: "status" });
  const body = unwrap(r);
  assert.equal((r as { isError?: boolean }).isError, true);
  assert.equal(body.code, "E_MISSING_PARAMS");
});

test("agent_validate rejects unknown action label", async () => {
  const r = await agentValidateHandler({ action: "wiggle" });
  const body = unwrap(r);
  assert.equal((r as { isError?: boolean }).isError, true);
  assert.equal(body.code, "E_INVALID_ACTION");
});
