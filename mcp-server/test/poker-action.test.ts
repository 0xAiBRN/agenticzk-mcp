// MC-13 — poker_action validation + legality unit tests.
//
// The handler chains RPC reads + on-chain state; mocking that surface is
// brittle. The two pre-flight steps (`_validateArgs` parsing and
// `_checkLegality` E_CANNOT_CHECK / E_RAISE_TOO_SMALL pattern) are pure and
// run before any RPC — those are the layers that catch the brain's most
// common misuses, so this suite asserts them with fixture state.
import "./_env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  _validateArgs,
  _checkLegality,
} from "../src/tools/poker_action.js";

const PLAYER = "0x29C2F998B325053F2e81532b5e3a44dac7A84978";
const TID = ("0x" + "11".repeat(32)) as `0x${string}`;

function unwrapErr(r: { isError?: boolean; content: { text: string }[] }) {
  assert.equal(r.isError, true, "expected error result");
  return JSON.parse(r.content[0].text);
}

// ---------------- _validateArgs ----------------

test("_validateArgs accepts a well-formed raise", () => {
  const r = _validateArgs({ player: PLAYER, tableId: TID, action: "raise", amount: "200" });
  assert.ok("valid" in r);
  assert.equal(r.valid.label, "raise");
  assert.equal(r.valid.enumValue, 3);
  assert.equal(r.valid.amount, 200n);
});

test("_validateArgs rejects allin (removed action)", () => {
  const r = _validateArgs({ player: PLAYER, tableId: TID, action: "allin" });
  assert.ok("error" in r);
  const body = unwrapErr(r.error);
  assert.equal(body.code, "E_ACTION_REMOVED");
});

test("_validateArgs rejects raise with amount=0", () => {
  const r = _validateArgs({ player: PLAYER, tableId: TID, action: "raise", amount: "0" });
  assert.ok("error" in r);
  const body = unwrapErr(r.error);
  assert.equal(body.code, "E_ZERO_AMOUNT");
});

test("_validateArgs rejects fold/check/call with non-zero amount", () => {
  for (const action of ["fold", "check", "call"]) {
    const r = _validateArgs({ player: PLAYER, tableId: TID, action, amount: "10" });
    assert.ok("error" in r, `${action} should reject amount>0`);
    const body = unwrapErr(r.error);
    assert.equal(body.code, "E_AMOUNT_NOT_ALLOWED");
  }
});

test("_validateArgs rejects non-numeric amount", () => {
  const r = _validateArgs({ player: PLAYER, tableId: TID, action: "raise", amount: "abc" });
  assert.ok("error" in r);
  const body = unwrapErr(r.error);
  assert.equal(body.code, "E_INVALID_AMOUNT");
});

test("_validateArgs rejects negative amount", () => {
  const r = _validateArgs({ player: PLAYER, tableId: TID, action: "raise", amount: "-5" });
  assert.ok("error" in r);
  const body = unwrapErr(r.error);
  assert.equal(body.code, "E_NEGATIVE_AMOUNT");
});

test("_validateArgs rejects zero tableId", () => {
  const r = _validateArgs({
    player: PLAYER,
    tableId: "0x" + "00".repeat(32),
    action: "fold",
  });
  assert.ok("error" in r);
  const body = unwrapErr(r.error);
  assert.equal(body.code, "E_INVALID_TABLE_ID");
});

test("_validateArgs rejects malformed address", () => {
  const r = _validateArgs({ player: "0xnope", tableId: TID, action: "fold" });
  assert.ok("error" in r);
  const body = unwrapErr(r.error);
  assert.equal(body.code, "E_INVALID_ADDRESS");
});

test("_validateArgs rejects unknown action label", () => {
  const r = _validateArgs({ player: PLAYER, tableId: TID, action: "wiggle" });
  assert.ok("error" in r);
  const body = unwrapErr(r.error);
  assert.equal(body.code, "E_INVALID_ACTION");
});

// ---------------- _checkLegality ----------------

const validRaise = (amount: bigint) =>
  ({ player: PLAYER, tableId: TID, label: "raise" as const, enumValue: 3, amount });
const validCheck = () =>
  ({ player: PLAYER, tableId: TID, label: "check" as const, enumValue: 1, amount: 0n });

test("_checkLegality E_CANNOT_CHECK when round.currentBet > seat.currentBet", () => {
  const err = _checkLegality(validCheck(), {
    seatCurrentBet: 0n,
    roundCurrentBet: 100n,
    roundMinRaise: 100n,
    roundReadOk: true,
  });
  assert.ok(err, "should reject illegal check");
  const body = unwrapErr(err);
  assert.equal(body.code, "E_CANNOT_CHECK");
});

test("_checkLegality allows check when callAmount == 0", () => {
  const err = _checkLegality(validCheck(), {
    seatCurrentBet: 50n,
    roundCurrentBet: 50n,
    roundMinRaise: 100n,
    roundReadOk: true,
  });
  assert.equal(err, null, "callAmount=0 → check legal");
});

test("_checkLegality E_RAISE_TOO_SMALL when amount < currentBet + minRaise", () => {
  const err = _checkLegality(validRaise(150n), {
    seatCurrentBet: 0n,
    roundCurrentBet: 100n,
    roundMinRaise: 100n,
    roundReadOk: true,
  });
  assert.ok(err, "should reject raise below minimum");
  const body = unwrapErr(err);
  assert.equal(body.code, "E_RAISE_TOO_SMALL");
});

test("_checkLegality allows raise at exact minimum", () => {
  const err = _checkLegality(validRaise(200n), {
    seatCurrentBet: 0n,
    roundCurrentBet: 100n,
    roundMinRaise: 100n,
    roundReadOk: true,
  });
  assert.equal(err, null, "amount == currentBet + minRaise → legal");
});

test("_checkLegality E_STATE_READ_FAILED when check needs round but read failed", () => {
  const err = _checkLegality(validCheck(), {
    seatCurrentBet: 0n,
    roundCurrentBet: 0n,
    roundMinRaise: 0n,
    roundReadOk: false,
  });
  assert.ok(err);
  const body = unwrapErr(err);
  assert.equal(body.code, "E_STATE_READ_FAILED");
});

test("_checkLegality skips raise min-raise check when round read failed (degrades to on-chain)", () => {
  const err = _checkLegality(validRaise(50n), {
    seatCurrentBet: 0n,
    roundCurrentBet: 0n,
    roundMinRaise: 0n,
    roundReadOk: false,
  });
  assert.equal(err, null, "raise pre-check skipped → contract decides");
});
