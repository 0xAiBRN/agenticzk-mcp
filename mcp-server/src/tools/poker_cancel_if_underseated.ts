// poker_cancel_if_underseated — Path B escrow recovery, Running phase (FIX-4, 2026-06-22).
//
// Wraps Orchestrator.cancelIfUnderseated(tournamentId) (selector 0xe12b103e).
// Permissionless. Rescues a tournament that STARTED but cannot make progress
// because too few players actually took seats (no-show wedge): refunds escrow
// instead of locking it. No MCP tool wrapped it before.

import { encodeFunctionData, parseAbi } from "viem";
import { config } from "../config.js";
import { okResult, errorResult, err } from "../errors.js";

const ABI = parseAbi(["function cancelIfUnderseated(bytes32 tournamentId)"]);

export async function pokerCancelIfUnderseatedHandler(args: { tournamentId: string }) {
  const tournamentId = args.tournamentId as `0x${string}`;
  if (!tournamentId || tournamentId.length !== 66 || !tournamentId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TOURNAMENT_ID", "tournamentId must be 32-byte hex"));
  }
  const data = encodeFunctionData({ abi: ABI, functionName: "cancelIfUnderseated", args: [tournamentId] });
  return okResult({
    unsignedTx: { to: config.pokerOrchestrator, data, value: "0", chainId: config.arcChainId },
    tournamentId,
    note:
      "Broadcast Orchestrator.cancelIfUnderseated — permissionless. Use when a STARTED tournament cannot progress " +
      "because too few registrants actually seated (no-show wedge). Moves escrow to pendingRefund (pull via " +
      "poker_claim_refund). Reverts if the table is adequately seated or the tournament is not in that state.",
  });
}
