// poker_expire_owner_share — C-02 fix (Codex mainnet-readiness audit 2026-05-26).
//
// Two anyone-callable wrappers in one module:
//   poker_arm_owner_share_deadline  — open the 60s countdown for a hole-card
//                                      owner to publish their showdown share.
//                                      Callable during Phase.Showdown.
//   poker_expire_owner_share        — after the deadline elapses without
//                                      submission, set the per-card forfeit
//                                      flag so ShowdownInvoker treats the
//                                      holding seat as a forced fold for
//                                      showdown evaluation (default loss,
//                                      not a slash — Sahip 2026-05-27).
//
// Closes the "losing player withholds owner share to freeze the table"
// strategic-veto exploit. The contract performs all guards; preflight
// here is informational.

import { encodeFunctionData, parseAbi } from "viem";
import { config } from "../config.js";
import { okResult, errorResult, err } from "../errors.js";

const ABI = parseAbi([
  "function armOwnerShareDeadline(bytes32 tableId, uint8 cardIdx)",
  "function expireOwnerShare(bytes32 tableId, uint8 cardIdx)",
] as const);

type Args = { tableId: string; cardIdx: number };

type ValidatedArgs =
  | { error: ReturnType<typeof err>; tableId?: undefined; cardIdx?: undefined }
  | { error?: undefined; tableId: `0x${string}`; cardIdx: number };

function validateArgs(args: Args): ValidatedArgs {
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66 || !tableId.startsWith("0x")) {
    return { error: err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex") };
  }
  if (
    args.cardIdx === undefined ||
    args.cardIdx === null ||
    !Number.isInteger(args.cardIdx) ||
    args.cardIdx < 0 ||
    args.cardIdx > 51
  ) {
    return { error: err("E_INVALID_CARD_IDX", "cardIdx must be integer in [0, 51]") };
  }
  return { tableId, cardIdx: args.cardIdx };
}

export async function pokerArmOwnerShareDeadlineHandler(args: Args) {
  const v = validateArgs(args);
  if (v.error) return errorResult(v.error);
  const data = encodeFunctionData({
    abi: ABI,
    functionName: "armOwnerShareDeadline",
    args: [v.tableId, v.cardIdx],
  });
  return okResult({
    unsignedTx: {
      to: config.pokerDecrypt,
      data,
      value: "0",
      chainId: config.arcChainId,
    },
    tableId: v.tableId,
    cardIdx: v.cardIdx,
    note:
      "Broadcast DecryptSystem.armOwnerShareDeadline. Anyone-callable in " +
      "Phase.Showdown. Sets the 60s deadline for the hole-card owner of " +
      "cardIdx to publish their showdown share. First arm wins; re-arm " +
      "reverts DeadlineAlreadyArmed. Reverts: NotInShowdown (phase wrong), " +
      "CardNotDecryptable (not a hole card), OwnerShareAlreadySubmitted " +
      "(submission already landed).",
  });
}

export async function pokerExpireOwnerShareHandler(args: Args) {
  const v = validateArgs(args);
  if (v.error) return errorResult(v.error);
  const data = encodeFunctionData({
    abi: ABI,
    functionName: "expireOwnerShare",
    args: [v.tableId, v.cardIdx],
  });
  return okResult({
    unsignedTx: {
      to: config.pokerDecrypt,
      data,
      value: "0",
      chainId: config.arcChainId,
    },
    tableId: v.tableId,
    cardIdx: v.cardIdx,
    note:
      "Broadcast DecryptSystem.expireOwnerShare. Anyone-callable after the " +
      "armed deadline has elapsed. Sets the per-card forfeit flag for " +
      "(tableId, cardIdx, current epoch). ShowdownInvoker reads this flag " +
      "and treats the holding seat as a forced fold for showdown " +
      "evaluation — the contested pot is distributed among the players " +
      "who DID reveal. The forfeiting seat keeps its remaining chip stack " +
      "(forced default loss, NOT a punitive slash — Sahip 2026-05-27 " +
      "decision). Reverts: DeadlineNotArmed (no prior arm), " +
      "DeadlineNotExpired (deadline in the future), " +
      "OwnerShareAlreadySubmitted (owner published in time), " +
      "AlreadyForfeited (second expire on the same slot), " +
      "CardNotDecryptable (not a hole card).",
  });
}
