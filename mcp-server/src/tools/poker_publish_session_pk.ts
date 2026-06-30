// poker_publish_session_pk — agent's per-TABLE session public-key publish.
//
// Real mental poker requires the joint encryption pk = Σ pk_i where each agent
// holds their own sk_i. This tool:
//   1. Derives (sk_i, pk_i) from the 256-bit session seed read from the
//      PLAYER_SESSION_SEED server env (not a tool argument — audit K#1).
//      `sk_i = seed mod subOrder`, `pk_i = sk_i · Base8` on BabyJubJub.
//   2. Encodes a `DealSystem.publishSessionPk(tableId, pk_x, pk_y)` tx.
//   3. Returns the unsignedTx + the derived PUBLIC pk.
//
// F-06 (Codex pre-mainnet audit, 2026-05-20): publish is ONCE PER TABLE, not
// per hand. DealSystem stores (sk_i, pk_i) table-scoped and
// `resetDealForNextHand` PRESERVES it — a second publish for the same table
// reverts (SessionPkAlreadyPublished). Each agent keeps the same key for every
// hand of the table; call this once, on the first hand only.
//
// F-04 (Codex pre-mainnet audit): the seed is the agent's SECRET and `sk` is
// derived from it. This tool returns ONLY the public pk + the unsignedTx — it
// NEVER returns `sk`, because the tool result is serialized into the agent's
// LLM conversation (brain.ts) and would otherwise leak the secret to the model
// provider.
//
// audit 2026-05-22 K#1: the seed itself is also a secret — when it was a tool
// argument every call serialized it into the LLM tool-call JSON, leaking it to
// the model provider just like a raw PK. The seed is now read from the
// PLAYER_SESSION_SEED server env (loadSessionSeed) and never enters the tool
// schema. The decrypt tools (poker_decrypt_share / poker_decrypt_batch /
// poker_recover_card) read the same env so the re-derived sk matches.

import { encodeFunctionData } from "viem";
import { config } from "../config.js";
import { PokerDealAbi } from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";
import { deriveSessionKeypair, buildSessionPkPoP } from "../zk/shuffle-input.js";
import { loadSessionSeed } from "../wallet-env.js";
import { validateAddress } from "../validate.js";

// C-1 (deep audit 2026-06-29) — publishSessionPk now runs 3 BabyJub scalarMuls
// on-chain (subgroup-check + s·Base8 + e·pk).
//
// GAS — pinned to Arc's MAXIMUM per-tx gas limit (16M), proven against live Arc:
//   - forge gas test (DealSystem.t.sol) measures ~6.94M on the STOCK-EVM gas
//     schedule. That is NOT Arc gas: Arc charges ~1.9x more for the mulmod/
//     addmod-heavy field arithmetic BabyJub hammers (3 scalarMuls: subgroup-
//     check + s·Base8 + e·pk), the same reason Arc has custom precompile pricing.
//   - 10M floor (forge × 1.4) OOG'd on live Arc: the production smoke showed
//     publishSessionPk mined-revert with gasUsed == 10,000,000 EXACTLY (cap →
//     OOG, not a proof revert which would refund) → the table bricks.
//   - Arc has a HARD per-transaction gas cap of 16,000,000 (empirically: a tx
//     with gas=16M is accepted, gas=18M is rejected "Transaction creation
//     failed"). So 16M is the ceiling — we cannot go higher.
//   - REAL Arc cost measured via eth_estimateGas across 14 random scalars:
//     12.89M–13.36M (≈13M, only ~3.5% spread — the constant doublings dominate;
//     popcount variance of e/s is small). Even the all-ones-scalar theoretical
//     worst (~15M) stays under 16M. So 16M gives ~20% headroom over the observed
//     max — safe. The wallet only pays the REAL gasUsed (~13M), not the cap.
// NOTE (mainnet): ~13M for a once-per-table op sits close to Arc's 16M cap.
// A gas-optimization pass (Strauss–Shamir simultaneous mul to fold s·Base8 +
// e·pk into ~one scalarMul, ≈8–9M) is a tracked mainnet-hardening item — it
// would restore comfortable margin. It is NOT a correctness blocker; 16M works.
// LESSON (HC#10): forge gas ≠ Arc gas + Arc has a per-tx cap — only a live
// production-path run surfaces both.
const PUBLISH_SESSION_PK_GAS = "16000000";

export async function pokerPublishSessionPkHandler(args: {
  tableId: string;
  /** C-1 — the wallet that will sign + broadcast this tx (= on-chain msg.sender).
   *  PUBLIC (no secret). Bound into the Schnorr challenge, so it MUST equal the
   *  broadcasting wallet or the on-chain proof verify fails. */
  agentAddress: string;
  /** Test-only — accepted ONLY when POKER_ALLOW_TOOL_SEED=1 (smoke pattern;
   *  per-agent multi-MCP child mainnet pattern, env-seed). */
  seed?: string;
}) {
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66 || !tableId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex (0x + 64 chars)"));
  }
  // C-1 — agentAddress is REQUIRED: it is the msg.sender the on-chain PoP
  // challenge binds to. A mismatch with the broadcasting wallet → verify fails.
  const agentAddress = validateAddress(args.agentAddress);
  if (!agentAddress) {
    return errorResult(
      err("E_INVALID_AGENT_ADDRESS", "agentAddress must be a valid 0x 20-byte address (the wallet that signs/broadcasts)"),
    );
  }

  // audit 2026-05-22 K#1 — session seed env-first; tool-arg fallback yalnızca
  // POKER_ALLOW_TOOL_SEED=1 flag'i altında (smoke uyumluluğu, production'da set
  // edilmez).
  const seedResult = loadSessionSeed(args.seed);
  if (typeof seedResult !== "bigint") {
    return errorResult(err("E_NO_SESSION_SEED", seedResult.error));
  }
  const seedBig = seedResult;

  // C-1 — derive sk (LOCAL ONLY) + pk, then build the Schnorr proof-of-possession.
  // `sk` and the nonce `r` NEVER leave this function: they would reveal the agent's
  // secret if serialized into the LLM tool result (the result is fed into brain.ts).
  let sk: bigint;
  let pk: [bigint, bigint];
  try {
    const kp = await deriveSessionKeypair(seedBig);
    sk = kp.sk;
    pk = kp.pk;
  } catch (e) {
    return errorResult(err("E_DERIVE_FAILED", `keypair derivation failed: ${(e as Error).message}`));
  }

  let proof: { Rx: bigint; Ry: bigint; s: bigint };
  try {
    proof = await buildSessionPkPoP({
      sk,
      pk,
      tableId,
      agentAddress,
      dealAddress: config.pokerDeal,
      chainId: config.arcChainId,
    });
  } catch (e) {
    return errorResult(
      err("E_POP_FAILED", `proof-of-possession build/self-verify failed: ${(e as Error).message}`),
    );
  }

  const data = encodeFunctionData({
    abi: PokerDealAbi,
    functionName: "publishSessionPk",
    args: [tableId, pk[0], pk[1], proof.Rx, proof.Ry, proof.s],
  });

  return okResult({
    unsignedTx: {
      to: config.pokerDeal,
      data,
      value: "0",
      gas: PUBLISH_SESSION_PK_GAS,
      chainId: config.arcChainId,
    },
    tableId,
    // C-1 — PUBLIC values only. `sk` and the nonce `r` are NEVER returned; the
    // Schnorr proof (Rx, Ry, s) is zero-knowledge under a fresh nonce and is
    // already in the public calldata.
    pkX: pk[0].toString(),
    pkY: pk[1].toString(),
    proof: { Rx: proof.Rx.toString(), Ry: proof.Ry.toString(), s: proof.s.toString() },
    note:
      "Call this ONCE PER TABLE (first hand only) BEFORE initDeal — the session " +
      "key is table-scoped and preserved across every hand; a second publish " +
      "reverts (SessionPkAlreadyPublished). After all seated agents have " +
      "published, the coordinator (poker_hand_start) sums the pks into the joint " +
      "pk for initDeal. The session seed is read from the PLAYER_SESSION_SEED " +
      "env on the MCP server — the decrypt tools re-derive sk from that same env " +
      "locally; do NOT pass a seed in any tool call.",
  });
}
