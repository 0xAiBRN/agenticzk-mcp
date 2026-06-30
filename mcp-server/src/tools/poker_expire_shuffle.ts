// poker_expire_shuffle — F-05 liveness (Codex end-user audit 2026-05-25).
//
// Anyone-callable wrapper for DealSystem.expireShuffle(tableId). Slashes
// the boycotting seat in the current shuffle round when shuffleDeadline has
// passed without that seat submitting a valid proof. The contract emits a
// ShuffleBoycott event, runs _slashShuffleOffender (-10 rep, 3rd consecutive
// → -50 + elimination), then voids the hand (refunds run inside
// TableSystem.voidHand).
//
// Note on DA-griefing: an honest agent that was handed a deck inconsistent
// with the chain commitment should call poker_report_shuffle_da_fault BEFORE
// its deadline expires — that path slashes the emitter instead.
// poker_expire_shuffle slashes whoever is stuck at the current round; for
// round 0 (input from storage) that is always a genuine boycott.

import { encodeFunctionData } from "viem";
import { config } from "../config.js";
import { PokerDealAbi } from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";
import { arcClient, readContractWithRetry } from "../chains.js";

export async function pokerExpireShuffleHandler(args: { tableId: string }) {
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66 || !tableId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex"));
  }

  // Pre-flight — shuffleDeadline armed and in the past. Cheap (single view).
  try {
    const deadline = (await readContractWithRetry({
      address: config.pokerDeal as `0x${string}`,
      abi: PokerDealAbi,
      functionName: "shuffleDeadline",
      args: [tableId],
    })) as bigint;
    if (deadline === 0n) {
      return errorResult(
        err(
          "E_DEADLINE_NOT_ARMED",
          "shuffleDeadline=0; either the deck is not initialized, shuffle is complete, or the deadline was already consumed",
        ),
      );
    }
    const head = await arcClient.getBlock({ blockTag: "latest" });
    if (head.timestamp < deadline) {
      return errorResult(
        err(
          "E_DEADLINE_NOT_EXPIRED",
          `shuffleDeadline=${deadline} > head.timestamp=${head.timestamp}; broadcast would revert ShuffleDeadlineNotExpired`,
          { deadline: deadline.toString(), headTimestamp: head.timestamp.toString() },
        ),
      );
    }
  } catch (e) {
    void e;
  }

  const data = encodeFunctionData({
    abi: PokerDealAbi,
    functionName: "expireShuffle",
    args: [tableId],
  });

  return okResult({
    unsignedTx: {
      to: config.pokerDeal,
      data,
      value: "0",
      chainId: config.arcChainId,
    },
    tableId,
    note:
      "Broadcast DealSystem.expireShuffle. Anyone-callable. Slashes the boycotting seat at " +
      "the current shuffle round (-10 reputation, 3rd consecutive → -50 + elimination) and " +
      "voids the hand. Honest agents handed a malformed deck should call " +
      "poker_report_shuffle_da_fault BEFORE the deadline instead. Reverts: DealNotInitialized, " +
      "ShuffleAlreadyComplete, ShuffleDeadlineNotArmed, ShuffleDeadlineNotExpired.",
  });
}
