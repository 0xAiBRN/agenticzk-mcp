// poker_cancel — Path B escrow recovery, Registering phase (FIX-4, 2026-06-22).
//
// Wraps Orchestrator.cancel(tournamentId) (selector 0xc4d252f5). Permissionless.
// If a tournament never fills (registered < minPlayers and it never starts), the
// ONLY way registered players get their entry fee back is cancel → claimRefund.
// No MCP tool wrapped it before, so a pure-MCP user could strand escrow forever.

import { encodeFunctionData, parseAbi } from "viem";
import { config } from "../config.js";
import { okResult, errorResult, err } from "../errors.js";

const CANCEL_ABI = parseAbi(["function cancel(bytes32 tournamentId)"]);

export async function pokerCancelHandler(args: { tournamentId: string }) {
  const tournamentId = args.tournamentId as `0x${string}`;
  if (!tournamentId || tournamentId.length !== 66 || !tournamentId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TOURNAMENT_ID", "tournamentId must be 32-byte hex"));
  }
  const data = encodeFunctionData({ abi: CANCEL_ABI, functionName: "cancel", args: [tournamentId] });
  return okResult({
    unsignedTx: { to: config.pokerOrchestrator, data, value: "0", chainId: config.arcChainId },
    tournamentId,
    note:
      "Broadcast Orchestrator.cancel — permissionless. Valid only while the tournament is in the Registering phase " +
      "(use it when a lobby never fills). Moves every registrant's entry fee to pendingRefund; each player then pulls " +
      "it via poker_claim_refund. No rake is taken on a cancel. Reverts if already started/finalized.",
  });
}
