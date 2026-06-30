// poker_reset_crypto — Path B next-hand bootstrap (FIX-4, 2026-06-22).
//
// Wraps HandFlowRouter.resetCryptoForNextHand(tableId) (selector 0x097dbb8d).
// Required between hands (hands 2+): clears the prior hand's shuffle/decrypt
// crypto state so the next hand can re-shuffle. No MCP tool wrapped it before,
// so a Path-B harness could play hand 1 but never advance. Caller policy
// (HandFlowRouter _assertDealerOrFallback): the dealer-button seat may call
// immediately; any other seated agent may call only after the ~30-block dealer
// grace window (FALLBACK_BLOCKS) since the last router trigger.

import { encodeFunctionData } from "viem";
import { config } from "../config.js";
import { PokerHandFlowRouterAbi } from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";

export async function pokerResetCryptoHandler(args: { tableId: string }) {
  if (!config.pokerHandFlowRouter) {
    return errorResult(
      err("E_NO_ROUTER", "POKER_HAND_FLOW_ROUTER is not configured — cannot build a reset-crypto tx (set it in env)."),
    );
  }
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66 || !tableId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex"));
  }
  const data = encodeFunctionData({
    abi: PokerHandFlowRouterAbi,
    functionName: "resetCryptoForNextHand",
    args: [tableId],
  });
  return okResult({
    unsignedTx: { to: config.pokerHandFlowRouter, data, value: "0", chainId: config.arcChainId },
    tableId,
    note:
      "Broadcast HandFlowRouter.resetCryptoForNextHand to clear the prior hand's shuffle/decrypt state before the " +
      "next hand. Callable by the dealer seat, or by any seated agent as a fallback after the ~30-block dealer grace " +
      "window. Call AFTER showdown/settle of the current hand and BEFORE the next poker_shuffle_prove round. " +
      "Then re-run publish_session_pk (if needed) → shuffle chain → poker_start_hand. Reverts: CallerNotSeated, " +
      "NotDealerOrFallback (seated but the dealer grace window has not elapsed).",
  });
}
