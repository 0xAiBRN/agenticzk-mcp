import { encodeFunctionData } from "viem";
import { config } from "../config.js";
import { PokerOrchestratorAbi } from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";
import { validateAddress } from "../validate.js";

/// @summary Pull a cancelled tournament refund from the orchestrator escrow.
///
/// @notice A tournament transitions to `Cancelled` when `cancel()` is called
///         after `registrationDeadline` while `registered < minPlayers`.
///         Cancellation queues the FULL `entryFee` in `pendingRefund[T][agentId]`
///         (rake never moves during Registering — 2026-05-10 deep-audit
///         refactor). Agent owner pulls the refund via `claimRefund`. Same
///         ERC-8004 ownership check as `claimPayout`.
export async function pokerClaimRefundHandler(args: {
  player: string;
  tournamentId: string;
  agentId: string;
}) {
  // audit 2026-05-22 MC-09 — runtime adres doğrulama.
  const player = validateAddress(args.player);
  if (!player) {
    return errorResult(err("E_INVALID_ADDRESS", "player must be a valid 0x-prefixed 20-byte address"));
  }
  const tournamentId = args.tournamentId as `0x${string}`;

  if (player === "0x0000000000000000000000000000000000000000") {
    return errorResult(err("E_INVALID_PLAYER", "player address cannot be zero"));
  }
  if (!tournamentId || !tournamentId.startsWith("0x") || tournamentId.length !== 66) {
    return errorResult(err("E_INVALID_TOURNAMENT_ID", "tournamentId must be a 0x-prefixed 32-byte hex string"));
  }

  let agentId: bigint;
  try {
    agentId = BigInt(args.agentId);
  } catch {
    return errorResult(err("E_INVALID_AGENT_ID", "agentId must be a numeric string"));
  }
  if (agentId <= 0n) {
    return errorResult(err("E_INVALID_AGENT_ID", "agentId must be positive"));
  }

  const data = encodeFunctionData({
    abi: PokerOrchestratorAbi,
    functionName: "claimRefund",
    args: [tournamentId, agentId],
  });

  return okResult({
    unsignedTxs: [
      {
        step: 1,
        purpose: "Orchestrator claimRefund — pull cancelled-tournament entry fee back",
        to: config.pokerOrchestrator,
        data,
        value: "0",
        chainId: config.arcChainId,
      },
    ],
    player,
    tournamentId,
    agentId: agentId.toString(),
    note: "Signer wallet MUST be the ERC-8004 owner of agentId. Tournament must be in Cancelled phase with pendingRefund > 0; otherwise the tx reverts with NothingToRefund / AgentNotOwned.",
  });
}
