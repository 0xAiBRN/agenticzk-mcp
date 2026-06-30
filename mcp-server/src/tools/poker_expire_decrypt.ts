// poker_expire_decrypt — F-05 liveness (Codex end-user audit 2026-05-25).
//
// Anyone-callable wrapper for DecryptSystem.expireDecrypt(tableId, cardIdx).
// Slashes all seats that owed a decrypt share for the named card after the
// per-card decryptDeadline has passed. The contract iterates the hand roster,
// records -10 reputation per offender (3rd consecutive → -50 + elimination),
// then voids the hand via TableSystem.voidHand (refunds run inside).
//
// cardIdx names a hole or community card; burn / unused cards have no
// decryption obligation and the contract rejects them (CardNotDecryptable).
//
// poker_arm_decrypt_deadline — ROUND-2 shuffle-reset-deadlock fix (Codex review
// 2026-06-01, finding (e) + non-owner-hole "Other" finding). Anyone-callable
// wrapper for DecryptSystem.armDecryptDeadline(tableId, cardIdx). Opens the
// 60s standard-decrypt countdown for a card whose share collection is stuck —
// a COMMUNITY card (N-of-N) or a SURVIVOR's hole card whose NON-OWNER shares
// (N-1) a dead/withholding seat is blocking. Without an arm the matching
// expireDecrypt rail can never fire (it requires decryptDeadline>0), so the
// table would freeze forever. Mirrors poker_arm_owner_share_deadline. First arm
// wins; re-arm reverts DeadlineAlreadyArmed. The contract enforces the
// per-street community window + role legality.

import { encodeFunctionData, parseAbi } from "viem";
import { config } from "../config.js";
import { PokerDecryptAbi } from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";
import { arcClient, readContractWithRetry } from "../chains.js";

const ARM_DECRYPT_ABI = parseAbi([
  "function armDecryptDeadline(bytes32 tableId, uint8 cardIdx)",
] as const);

export async function pokerExpireDecryptHandler(args: {
  tableId: string;
  cardIdx: number | string;
}) {
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66 || !tableId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex"));
  }

  let cardIdx: number;
  try {
    cardIdx = typeof args.cardIdx === "number" ? args.cardIdx : Number(args.cardIdx);
  } catch {
    return errorResult(err("E_INVALID_CARD_IDX", "cardIdx must be an integer 0-51"));
  }
  if (!Number.isInteger(cardIdx) || cardIdx < 0 || cardIdx > 51) {
    return errorResult(err("E_INVALID_CARD_IDX", "cardIdx must be an integer 0-51"));
  }

  // Pre-flight — decryptDeadline (current epoch) armed and in the past.
  try {
    const deadline = (await readContractWithRetry({
      address: config.pokerDecrypt as `0x${string}`,
      abi: PokerDecryptAbi,
      functionName: "decryptDeadline",
      args: [tableId, cardIdx],
    })) as bigint;
    if (deadline === 0n) {
      return errorResult(
        err(
          "E_DEADLINE_NOT_ARMED",
          `decryptDeadline(card=${cardIdx})=0; either no shares are pending, card already revealed, or deadline was already consumed`,
        ),
      );
    }
    const head = await arcClient.getBlock({ blockTag: "latest" });
    if (head.timestamp < deadline) {
      return errorResult(
        err(
          "E_DEADLINE_NOT_EXPIRED",
          `decryptDeadline=${deadline} > head.timestamp=${head.timestamp}; broadcast would revert DeadlineNotExpired`,
          { deadline: deadline.toString(), headTimestamp: head.timestamp.toString(), cardIdx },
        ),
      );
    }
  } catch (e) {
    void e;
  }

  const data = encodeFunctionData({
    abi: PokerDecryptAbi,
    functionName: "expireDecrypt",
    args: [tableId, cardIdx],
  });

  return okResult({
    unsignedTx: {
      to: config.pokerDecrypt,
      data,
      value: "0",
      chainId: config.arcChainId,
    },
    tableId,
    cardIdx,
    note:
      "Broadcast DecryptSystem.expireDecrypt. Anyone-callable. Slashes all seats that owed " +
      "a share for this card (-10 reputation each, 3rd consecutive → -50 + elimination), " +
      "then voids the hand. cardIdx must name a hole or community card (burn cards have no " +
      "obligation). Reverts: DealNotInitialized, InvalidCard, DeadlineNotArmed, " +
      "DeadlineNotExpired, AlreadyRevealed, TableHasNoPlayers, CardNotDecryptable.",
  });
}

export async function pokerArmDecryptDeadlineHandler(args: {
  tableId: string;
  cardIdx: number | string;
}) {
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66 || !tableId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex"));
  }

  let cardIdx: number;
  try {
    cardIdx = typeof args.cardIdx === "number" ? args.cardIdx : Number(args.cardIdx);
  } catch {
    return errorResult(err("E_INVALID_CARD_IDX", "cardIdx must be an integer 0-51"));
  }
  if (!Number.isInteger(cardIdx) || cardIdx < 0 || cardIdx > 51) {
    return errorResult(err("E_INVALID_CARD_IDX", "cardIdx must be an integer 0-51"));
  }

  // Pre-flight — refuse if a deadline is already armed (re-arm would revert
  // DeadlineAlreadyArmed). Informational only; the contract is the backstop.
  try {
    const deadline = (await readContractWithRetry({
      address: config.pokerDecrypt as `0x${string}`,
      abi: PokerDecryptAbi,
      functionName: "decryptDeadline",
      args: [tableId, cardIdx],
    })) as bigint;
    if (deadline !== 0n) {
      return errorResult(
        err(
          "E_DEADLINE_ALREADY_ARMED",
          `decryptDeadline(card=${cardIdx})=${deadline}; already armed (first arm wins)`,
          { deadline: deadline.toString(), cardIdx },
        ),
      );
    }
  } catch (e) {
    void e;
  }

  const data = encodeFunctionData({
    abi: ARM_DECRYPT_ABI,
    functionName: "armDecryptDeadline",
    args: [tableId, cardIdx],
  });

  return okResult({
    unsignedTx: {
      to: config.pokerDecrypt,
      data,
      value: "0",
      chainId: config.arcChainId,
    },
    tableId,
    cardIdx,
    note:
      "Broadcast DecryptSystem.armDecryptDeadline. Anyone-callable. Opens the 60s " +
      "standard-decrypt countdown for a stuck card: a COMMUNITY card (N-of-N) or a " +
      "survivor's hole card whose NON-OWNER shares (N-1) a dead/withholding seat is " +
      "blocking. First arm wins; re-arm reverts DeadlineAlreadyArmed. Use with " +
      "poker_expire_decrypt once the deadline elapses to slash the boycotter and void " +
      "the hand (honest seats refunded). cardIdx must name a hole or community card. " +
      "Reverts: DealNotInitialized, InvalidCard, TableHasNoPlayers, CardNotDecryptable " +
      "(burn/unused), PhaseTooEarly (community card before its street), AlreadyRevealed, " +
      "DeadlineAlreadyArmed.",
  });
}
