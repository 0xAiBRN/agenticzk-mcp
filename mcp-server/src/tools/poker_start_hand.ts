// poker_start_hand — Path B hand bootstrap (FIX-4, 2026-06-22).
//
// Wraps HandFlowRouter.startHandAndInitRound(tableId) (selector 0xb15465ff) — the
// ONLY authorized way to start a hand. poker_hand_start's withStartHand option
// targets TableSystem.startHand directly, which reverts NotAuthorized for an EOA
// (only the router is authorized). Caller must be SEATED and the deck shuffle
// chain complete (isReadyToStartHand==true). Caller policy (HandFlowRouter
// _assertDealerOrFallback): the dealer-button seat may call immediately; any
// other seated agent may call only after the ~30-block dealer grace window
// (FALLBACK_BLOCKS) since the last router trigger; on the first hand (no dealer
// set yet) any seated agent may bootstrap.

import { encodeFunctionData, parseAbi } from "viem";
import { config } from "../config.js";
import { PokerHandFlowRouterAbi } from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";
import { readContractWithRetry } from "../chains.js";

const DEAL_READY_ABI = parseAbi(["function isReadyToStartHand(bytes32) view returns (bool)"]);

export async function pokerStartHandHandler(args: { tableId: string }) {
  if (!config.pokerHandFlowRouter) {
    return errorResult(
      err("E_NO_ROUTER", "POKER_HAND_FLOW_ROUTER is not configured — cannot build a hand-start tx (set it in env)."),
    );
  }
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66 || !tableId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex"));
  }

  // Non-fatal preflight — deck shuffle chain complete? Cheap single view; the
  // router still enforces it on broadcast (DealNotReadyForStart).
  try {
    const ready = (await readContractWithRetry({
      address: config.pokerDeal,
      abi: DEAL_READY_ABI,
      functionName: "isReadyToStartHand",
      args: [tableId],
    })) as boolean;
    if (!ready) {
      return errorResult(
        err(
          "E_DEAL_NOT_READY",
          "isReadyToStartHand==false — the seat-ordered shuffle chain is not complete yet; broadcasting would revert. " +
            "Finish poker_shuffle_prove for every seat first.",
        ),
      );
    }
  } catch (e) {
    void e; // RPC blip — fall through; the router enforces on broadcast.
  }

  const data = encodeFunctionData({
    abi: PokerHandFlowRouterAbi,
    functionName: "startHandAndInitRound",
    args: [tableId],
  });
  return okResult({
    unsignedTx: { to: config.pokerHandFlowRouter, data, value: "0", chainId: config.arcChainId },
    tableId,
    note:
      "Broadcast HandFlowRouter.startHandAndInitRound. Posts blinds, deals hole cards, and inits the first betting " +
      "round. Callable by the dealer seat, or by any seated agent as a fallback after the ~30-block dealer grace window " +
      "(on the first hand any seated agent may bootstrap). The deck shuffle chain must be complete. Reverts: " +
      "CallerNotSeated, NotDealerOrFallback (you are seated but the dealer grace window has not elapsed), " +
      "DealNotReadyForStart, NotAuthorized (if you targeted TableSystem.startHand directly instead of the router).",
  });
}
