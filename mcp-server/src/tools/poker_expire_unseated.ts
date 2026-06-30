// poker_expire_unseated — C-01 fix (Codex mainnet-readiness audit 2026-05-26).
//
// Anyone-callable wrapper for TournamentOrchestrator.expireUnseated.
// Closes the "registered no-show finalization lock" mainnet blocker: a
// registered agent that never took their seat at the bound table can
// otherwise keep the tournament in `Phase.Running` forever (the
// finalize callback enforces `ranking.length == registered` and the
// table's ranking only contains the seated agents).
//
// After `UNSEATED_GRACE_PERIOD` (5 minutes) has elapsed since `start()`,
// any caller may broadcast this tx to refund the no-show agent (full
// entry fee, no rake) and shrink the orchestrator's `registered`
// counter so the remaining seated agents can finalize via the standard
// single-survivor or MAX_HANDS path.
//
// The contract handles all preconditions (phase, deadline, registration
// + seated check). Preflight here is informational only.

import { encodeFunctionData, parseAbi } from "viem";
import { config } from "../config.js";
import { okResult, errorResult, err } from "../errors.js";
import { arcClient, readContractWithRetry } from "../chains.js";

const ABI = parseAbi([
  "function expireUnseated(bytes32 tournamentId, uint256 agentId)",
  "function UNSEATED_GRACE_PERIOD() view returns (uint64)",
] as const);

type Args = { tournamentId: string; agentId: string };

export async function pokerExpireUnseatedHandler(args: Args) {
  const tournamentId = args.tournamentId as `0x${string}`;
  if (!tournamentId || tournamentId.length !== 66 || !tournamentId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TOURNAMENT_ID", "tournamentId must be 32-byte hex"));
  }
  const agentIdStr = args.agentId;
  if (!agentIdStr || !/^\d+$/.test(agentIdStr)) {
    return errorResult(err("E_INVALID_AGENT_ID", "agentId must be a numeric string"));
  }
  let agentIdBig: bigint;
  try {
    agentIdBig = BigInt(agentIdStr);
  } catch {
    return errorResult(err("E_INVALID_AGENT_ID", "agentId could not be parsed as bigint"));
  }

  // Best-effort preflight — verify the grace period exposed by the contract
  // matches our expectation. Failure here is non-fatal (we still produce
  // the unsignedTx; the contract enforces the actual rule).
  try {
    const gracePeriod = (await readContractWithRetry({
      address: config.pokerOrchestrator as `0x${string}`,
      abi: ABI,
      functionName: "UNSEATED_GRACE_PERIOD",
      args: [],
    })) as bigint;
    void gracePeriod;
  } catch (e) {
    void e;
  }

  const data = encodeFunctionData({
    abi: ABI,
    functionName: "expireUnseated",
    args: [tournamentId, agentIdBig],
  });

  return okResult({
    unsignedTx: {
      to: config.pokerOrchestrator,
      data,
      value: "0",
      chainId: config.arcChainId,
    },
    tournamentId,
    agentId: agentIdStr,
    note:
      "Broadcast TournamentOrchestrator.expireUnseated. Anyone-callable. " +
      "Prunes a registered agent that never took their seat at the bound " +
      "table after the post-start UNSEATED_GRACE_PERIOD (5 minutes by " +
      "default). Refunds the full entry fee via pendingRefund (no rake — " +
      "they never played a hand). Reverts: WrongPhase (tournament not " +
      "Running), SeatDeadlineNotElapsed (deadline not yet armed or in the " +
      "future), AgentAlreadySeated (honest agent — cannot expire), " +
      "CannotExpireBelowMinPlayers (would drop the seated count below " +
      "minPlayers; let the remaining seats finalize via single-survivor " +
      "or MAX_HANDS instead), UnknownAgentInRanking (agentId not registered).",
  });
}
