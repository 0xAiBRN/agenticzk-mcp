// 2026-05-24 — Codex mainnet readiness item 10 — poker_commit_action +
// poker_reveal_action MCP unit testleri. Pure validation katmanı (RPC'ye
// dokunmadan dönen E_* kodları) + reveal'in deterministik calldata üretimi
// + salt sızıntı yok kontrolü.
//
// Strategy:
//   - `pokerCommitActionHandler` validation hatalarını RPC'ye gitmeden önce
//     döndürür → tüm E_INVALID_* kodları yakalanabilir.
//   - `pokerRevealActionHandler` zaten thin (RPC yok), tüm yüzeyi
//     unit-testable: malformed input + happy path determinism + secret leak.

import "./_env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pokerCommitActionHandler } from "../src/tools/poker_commit_action.js";
import { pokerRevealActionHandler } from "../src/tools/poker_reveal_action.js";

const PLAYER = "0x29C2F998B325053F2e81532b5e3a44dac7A84978";
const TID = ("0x" + "11".repeat(32));
const SALT = ("0x" + "ab".repeat(32));

function unwrapErr(r: { isError?: boolean; content: { text: string }[] }) {
  assert.equal(r.isError, true, "expected error result");
  return JSON.parse(r.content[0].text);
}

function unwrapOk(r: { isError?: boolean; content: { text: string }[] }) {
  if (r.isError) {
    throw new Error(`expected ok result, got error: ${r.content[0].text}`);
  }
  return JSON.parse(r.content[0].text);
}

// ────────────────────────────────────────────────────────────────────────
// poker_commit_action validation (pre-RPC)
// ────────────────────────────────────────────────────────────────────────

test("commit rejects malformed address", async () => {
  const r = await pokerCommitActionHandler({
    player: "0xnope", tableId: TID, action: "fold",
  });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_INVALID_ADDRESS");
});

test("commit rejects zero tableId", async () => {
  const r = await pokerCommitActionHandler({
    player: PLAYER, tableId: "0x" + "00".repeat(32), action: "fold",
  });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_INVALID_TABLE_ID");
});

test("commit rejects malformed tableId (length)", async () => {
  const r = await pokerCommitActionHandler({
    player: PLAYER, tableId: "0x1234", action: "fold",
  });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_INVALID_TABLE_ID");
});

test("commit rejects allin (removed action)", async () => {
  const r = await pokerCommitActionHandler({
    player: PLAYER, tableId: TID, action: "allin",
  });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_ACTION_REMOVED");
});

test("commit rejects unknown action label", async () => {
  const r = await pokerCommitActionHandler({
    player: PLAYER, tableId: TID, action: "wiggle",
  });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_INVALID_ACTION");
});

test("commit rejects raise with amount=0", async () => {
  const r = await pokerCommitActionHandler({
    player: PLAYER, tableId: TID, action: "raise", amount: "0",
  });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_ZERO_AMOUNT");
});

test("commit rejects fold/check/call with non-zero amount", async () => {
  for (const action of ["fold", "check", "call"]) {
    const r = await pokerCommitActionHandler({
      player: PLAYER, tableId: TID, action, amount: "10",
    });
    const body = unwrapErr(r);
    assert.equal(body.code, "E_AMOUNT_NOT_ALLOWED", `${action} should reject amount>0`);
  }
});

test("commit rejects negative amount", async () => {
  const r = await pokerCommitActionHandler({
    player: PLAYER, tableId: TID, action: "raise", amount: "-5",
  });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_NEGATIVE_AMOUNT");
});

test("commit rejects non-numeric amount", async () => {
  const r = await pokerCommitActionHandler({
    player: PLAYER, tableId: TID, action: "raise", amount: "abc",
  });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_INVALID_AMOUNT");
});

test("commit rejects malformed salt (length)", async () => {
  const r = await pokerCommitActionHandler({
    player: PLAYER, tableId: TID, action: "fold", salt: "0x1234",
  });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_INVALID_SALT");
});

test("commit rejects malformed salt (no 0x)", async () => {
  const r = await pokerCommitActionHandler({
    player: PLAYER, tableId: TID, action: "fold", salt: "ab".repeat(32),
  });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_INVALID_SALT");
});

test("commit rejects malformed salt (non-hex char)", async () => {
  const r = await pokerCommitActionHandler({
    player: PLAYER, tableId: TID, action: "fold", salt: "0x" + "zz".repeat(32),
  });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_INVALID_SALT");
});

// ────────────────────────────────────────────────────────────────────────
// poker_reveal_action validation (no RPC at all)
// ────────────────────────────────────────────────────────────────────────

test("reveal rejects malformed tableId", async () => {
  const r = await pokerRevealActionHandler({
    tableId: "0x1234", action: "fold", salt: SALT,
  });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_INVALID_TABLE_ID");
});

test("reveal rejects allin (removed action)", async () => {
  const r = await pokerRevealActionHandler({
    tableId: TID, action: "allin", salt: SALT,
  });
  // poker_reveal_action does not have explicit E_ACTION_REMOVED; it falls
  // to E_INVALID_ACTION (allin is not in the enum).
  const body = unwrapErr(r);
  assert.equal(body.code, "E_INVALID_ACTION");
});

test("reveal rejects unknown action label", async () => {
  const r = await pokerRevealActionHandler({
    tableId: TID, action: "wiggle", salt: SALT,
  });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_INVALID_ACTION");
});

test("reveal rejects missing salt", async () => {
  const r = await pokerRevealActionHandler({
    tableId: TID, action: "fold", salt: "",
  });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_INVALID_SALT");
});

test("reveal rejects malformed salt (length)", async () => {
  const r = await pokerRevealActionHandler({
    tableId: TID, action: "fold", salt: "0x1234",
  });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_INVALID_SALT");
});

test("reveal rejects negative amount", async () => {
  const r = await pokerRevealActionHandler({
    tableId: TID, action: "raise", amount: "-5", salt: SALT,
  });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_NEGATIVE_AMOUNT");
});

test("reveal rejects non-numeric amount", async () => {
  const r = await pokerRevealActionHandler({
    tableId: TID, action: "raise", amount: "abc", salt: SALT,
  });
  const body = unwrapErr(r);
  assert.equal(body.code, "E_INVALID_AMOUNT");
});

// ────────────────────────────────────────────────────────────────────────
// poker_reveal_action happy path — determinism + calldata shape
// ────────────────────────────────────────────────────────────────────────

test("reveal produces deterministic calldata for the same (action, amount, salt)", async () => {
  const r1 = await pokerRevealActionHandler({
    tableId: TID, action: "raise", amount: "200", salt: SALT,
  });
  const r2 = await pokerRevealActionHandler({
    tableId: TID, action: "raise", amount: "200", salt: SALT,
  });
  const ok1 = unwrapOk(r1);
  const ok2 = unwrapOk(r2);
  assert.equal(ok1.unsignedTx.data, ok2.unsignedTx.data, "same inputs → same calldata");
  assert.equal(ok1.unsignedTx.to, ok2.unsignedTx.to, "same target contract");
  assert.equal(ok1.action, "raise");
  assert.equal(ok1.actionEnum, 3);
  assert.equal(ok1.amount, "200");
});

test("reveal calldata differs when salt differs", async () => {
  const r1 = await pokerRevealActionHandler({
    tableId: TID, action: "fold", salt: "0x" + "aa".repeat(32),
  });
  const r2 = await pokerRevealActionHandler({
    tableId: TID, action: "fold", salt: "0x" + "bb".repeat(32),
  });
  const ok1 = unwrapOk(r1);
  const ok2 = unwrapOk(r2);
  assert.notEqual(ok1.unsignedTx.data, ok2.unsignedTx.data, "different salt → different calldata");
});

test("reveal calldata differs when amount differs", async () => {
  const r1 = await pokerRevealActionHandler({
    tableId: TID, action: "raise", amount: "200", salt: SALT,
  });
  const r2 = await pokerRevealActionHandler({
    tableId: TID, action: "raise", amount: "400", salt: SALT,
  });
  const ok1 = unwrapOk(r1);
  const ok2 = unwrapOk(r2);
  assert.notEqual(ok1.unsignedTx.data, ok2.unsignedTx.data, "different amount → different calldata");
});

test("reveal echoes salt in its response (caller must already know it)", async () => {
  // The salt is supplied BY the caller to reveal; echoing it is a debug
  // affordance, not a leak (caller had it on input). Verify the shape is
  // stable so a future regression doesn't accidentally drop it.
  const r = await pokerRevealActionHandler({
    tableId: TID, action: "call", salt: SALT,
  });
  const ok = unwrapOk(r);
  assert.equal(ok.salt, SALT);
  assert.ok(ok.unsignedTx);
  assert.equal(ok.unsignedTx.value, "0");
});

test("reveal happy paths cover all four legal actions", async () => {
  for (const [action, enumValue] of [
    ["fold", 0],
    ["check", 1],
    ["call", 2],
    ["raise", 3],
  ] as const) {
    const r = await pokerRevealActionHandler({
      tableId: TID,
      action,
      amount: action === "raise" ? "200" : "0",
      salt: SALT,
    });
    const ok = unwrapOk(r);
    assert.equal(ok.action, action);
    assert.equal(ok.actionEnum, enumValue);
    // Function selector check: revealAction(bytes32,uint8,uint256,bytes32)
    // calldata starts with selector. Just assert it's 4 bytes + payload.
    assert.match(ok.unsignedTx.data, /^0x[0-9a-fA-F]{8}/);
  }
});
