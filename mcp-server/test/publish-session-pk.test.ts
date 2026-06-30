// F-12 — poker_publish_session_pk is the one RPC-free poker tool (seed →
// keypair → calldata, all pure), so it can be unit-tested end to end. It also
// carries the F-04 (no sk leak) and F-06 (per-table semantics) fixes — both
// asserted here.
import "./_env.js"; // F-12 — MUST be first: dummy env so config.ts can load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, keccak256, encodeAbiParameters, stringToBytes } from "viem";
import { buildBabyjub } from "circomlibjs";
import { pokerPublishSessionPkHandler } from "../src/tools/poker_publish_session_pk.js";
import { deriveSessionKeypair, buildSessionPkPoP } from "../src/zk/shuffle-input.js";
import { PokerDealAbi } from "../src/poker-abis.js";

const TID = ("0x" + "11".repeat(32)) as `0x${string}`;
const ADDR = ("0x" + "22".repeat(20)) as `0x${string}`; // C-1 — the broadcasting wallet (msg.sender bound into the PoP)
const SEED = "0x" + "ab".repeat(32);
// audit 2026-05-22 K#1 — session seed artık bir tool argümanı DEĞİL; handler
// PLAYER_SESSION_SEED env'inden okur (LLM seed'i görmez). Test bu env'i set eder.
process.env.PLAYER_SESSION_SEED = SEED;

function unwrap(r: unknown): Record<string, unknown> {
  return JSON.parse((r as { content: { text: string }[] }).content[0].text);
}

test("poker_publish_session_pk builds a publishSessionPk unsignedTx", async () => {
  const r = await pokerPublishSessionPkHandler({ tableId: TID, agentAddress: ADDR });
  assert.notEqual((r as { isError?: boolean }).isError, true, "not an error result");
  const data = unwrap(r);
  const tx = data.unsignedTx as { to: string; data: `0x${string}` };
  assert.ok(tx, "result carries an unsignedTx");
  const decoded = decodeFunctionData({ abi: PokerDealAbi, data: tx.data });
  assert.equal(decoded.functionName, "publishSessionPk");
  assert.equal((decoded.args as unknown[])[0], TID, "calldata arg0 = tableId");
});

test("poker_publish_session_pk NEVER returns sk — F-04 secret-leak fix", async () => {
  const data = unwrap(await pokerPublishSessionPkHandler({ tableId: TID, agentAddress: ADDR }));
  assert.equal(data.sk, undefined, "sk must not appear in the tool result");
  assert.ok(data.pkX, "public pkX is returned");
  assert.ok(data.pkY, "public pkY is returned");
});

test("poker_publish_session_pk note states per-table semantics — F-06", async () => {
  const data = unwrap(await pokerPublishSessionPkHandler({ tableId: TID, agentAddress: ADDR }));
  assert.match(String(data.note), /ONCE PER TABLE/);
});

test("poker_publish_session_pk is deterministic — same seed → same pk", async () => {
  const a = unwrap(await pokerPublishSessionPkHandler({ tableId: TID, agentAddress: ADDR }));
  const b = unwrap(await pokerPublishSessionPkHandler({ tableId: TID, agentAddress: ADDR }));
  assert.equal(a.pkX, b.pkX);
  assert.equal(a.pkY, b.pkY);
});

test("poker_publish_session_pk rejects a malformed tableId", async () => {
  const r = await pokerPublishSessionPkHandler({ tableId: "0xdeadbeef", agentAddress: ADDR });
  assert.equal((r as { isError?: boolean }).isError, true);
});

// C-1 (deep audit 2026-06-29) — agentAddress is REQUIRED (it is the msg.sender
// bound into the Schnorr challenge).
test("poker_publish_session_pk requires agentAddress", async () => {
  const r = await pokerPublishSessionPkHandler({ tableId: TID } as never);
  assert.equal((r as { isError?: boolean }).isError, true);
});

// C-1 R1 (CATASTROPHIC residual guard) — two publishes for the SAME seed MUST
// use a FRESH CSPRNG nonce, i.e. emit a DIFFERENT R. A deterministic/seed-derived
// nonce reused across two tables leaks sk = (s1-s2)/(e1-e2). pk stays equal (it
// derives from the seed), but the proof nonce R must differ every call.
test("poker_publish_session_pk uses a fresh nonce — different R per call (R1)", async () => {
  const a = unwrap(await pokerPublishSessionPkHandler({ tableId: TID, agentAddress: ADDR }));
  const b = unwrap(await pokerPublishSessionPkHandler({ tableId: TID, agentAddress: ADDR }));
  const pa = a.proof as { Rx: string; Ry: string; s: string };
  const pb = b.proof as { Rx: string; Ry: string; s: string };
  assert.notEqual(pa.Rx, pb.Rx, "nonce R reused across calls — CSPRNG regression, sk-recovery risk");
});

// C-1 — the secret nonce r is NEVER returned (only the zero-knowledge proof).
test("poker_publish_session_pk NEVER returns the nonce r or the seed", async () => {
  const data = unwrap(await pokerPublishSessionPkHandler({ tableId: TID, agentAddress: ADDR }));
  assert.equal(data.r, undefined, "nonce r must not appear (leaks sk with the public s)");
  assert.equal(data.seed, undefined, "seed must not appear");
  const proof = data.proof as { Rx?: string; s?: string };
  assert.ok(proof?.Rx && proof?.s, "public proof (Rx, s) IS returned");
});

// C1-INFO-1 (hard audit 2026-06-30) — GOLDEN ENCODING LOCK. The MCP's internal
// Fiat-Shamir challenge `e` MUST be byte-identical to DealSystem.publishSessionPk's
// on-chain keccak256(abi.encode(...)) or every publish reverts SessionPkProofInvalid
// on-chain (burning ~13M gas) — a desync the structural self-verify (a tautology)
// CANNOT catch. This test recomputes `e` the CONTRACT way (the frozen field
// layout below is the canonical contract spec — NEVER change it to match a
// refactored MCP) and independently verifies s·Base8 == R + e·pk. If a future
// refactor reorders/retypes the MCP abi.encode, e_mcp ≠ e_contract → this FAILS.
const SUB_ORDER =
  2736030358979909402780800718157159386076813972158567259200215660948447373041n;
test("C1-INFO-1: MCP PoP `e` encoding is byte-locked to the contract keccak", async () => {
  const DEAL = "0x2a9fb393972c4b31a89410de7d411c4b5113d9e3" as `0x${string}`;
  const CHAIN = 5042002;
  const { sk, pk } = await deriveSessionKeypair(424242n);
  const { Rx, Ry, s } = await buildSessionPkPoP({
    sk, pk, tableId: TID, agentAddress: ADDR, dealAddress: DEAL, chainId: CHAIN,
  });
  // FROZEN contract spec — DealSystem.sol publishSessionPk:
  //   e = keccak256(abi.encode(POP_DOMAIN, block.chainid, address(this),
  //                            tableId, msg.sender, pkX, pkY, Rx, Ry)) % L
  const POP_DOMAIN = keccak256(stringToBytes("AgenticZK.DealSystem.SessionPkPoP.v1"));
  const e = BigInt(keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "uint256" }, { type: "address" },
      { type: "bytes32" }, { type: "address" }, { type: "uint256" },
      { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
    ],
    [POP_DOMAIN, BigInt(CHAIN), DEAL, TID, ADDR, pk[0], pk[1], Rx, Ry],
  ))) % SUB_ORDER;
  // Independently verify the returned proof against the CONTRACT-derived e.
  const bj = await buildBabyjub();
  const lhs = bj.mulPointEscalar(bj.Base8, s) as [Uint8Array, Uint8Array];
  const Rpt: [Uint8Array, Uint8Array] = [bj.F.e(Rx), bj.F.e(Ry)];
  const pkPt: [Uint8Array, Uint8Array] = [bj.F.e(pk[0]), bj.F.e(pk[1])];
  const rhs = bj.addPoint(Rpt, bj.mulPointEscalar(pkPt, e)) as [Uint8Array, Uint8Array];
  assert.equal(
    bj.F.toString(lhs[0]), bj.F.toString(rhs[0]),
    "MCP abi.encode `e` DESYNCED from contract keccak — every publishSessionPk would revert on-chain",
  );
  assert.equal(bj.F.toString(lhs[1]), bj.F.toString(rhs[1]));
});
