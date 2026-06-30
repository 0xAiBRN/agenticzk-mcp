// poker_abandon_settlement — Path B last-resort escrow recovery (FIX-4, 2026-06-22).
//
// Wraps Orchestrator.abandonSettlement(tournamentId) (selector 0x9a3dd148).
// Permissionless. The contract's final "funds can never lock" guarantee: a
// 12h stall watchdog. It is a 2-CALL ritual — the first call ARMS the watchdog,
// and a second call after the timeout elapses SETTLES (refunds) the abandoned
// tournament. No MCP tool wrapped it before.

import { encodeFunctionData, parseAbi } from "viem";
import { config } from "../config.js";
import { okResult, errorResult, err } from "../errors.js";

const ABI = parseAbi(["function abandonSettlement(bytes32 tournamentId)"]);

export async function pokerAbandonSettlementHandler(args: { tournamentId: string }) {
  const tournamentId = args.tournamentId as `0x${string}`;
  if (!tournamentId || tournamentId.length !== 66 || !tournamentId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TOURNAMENT_ID", "tournamentId must be 32-byte hex"));
  }
  const data = encodeFunctionData({ abi: ABI, functionName: "abandonSettlement", args: [tournamentId] });
  return okResult({
    unsignedTx: { to: config.pokerOrchestrator, data, value: "0", chainId: config.arcChainId },
    tournamentId,
    note:
      "Broadcast Orchestrator.abandonSettlement — permissionless last-resort. TWO-CALL ritual: the FIRST call ARMS a " +
      "12h stall watchdog; broadcast it again AFTER the timeout elapses to SETTLE (refund escrow → pendingRefund, " +
      "pulled via poker_claim_refund). Reverts: AbandonWatchdogArmed (already armed, wait), AbandonTimeoutNotElapsed " +
      "(too early — re-broadcast after 12h), FinalizeParkedUseRetry (a finalize is parked — use " +
      "poker_retry_tournament_finalize instead). Only needed if a tournament truly wedges; normal finalize is automatic.",
  });
}
