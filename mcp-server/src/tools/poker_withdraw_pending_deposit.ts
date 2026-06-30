import { encodeFunctionData } from "viem";
import { config } from "../config.js";
import { PokerOrchestratorAbi } from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";
import { validateAddress } from "../validate.js";

/// @summary Pull an unconsumed pending deposit back to the depositor.
///
/// @notice H2 (HIGH-01 fix, 2026-05-06): `depositFor` credits funds to the
///         `(tournamentId, depositor, agentId)` ledger slot. If the depositor
///         never calls `register` (e.g. they changed their mind, or a
///         front-run consumed the direct transfer they intended to use),
///         the slot is recoverable via `withdrawPendingDeposit` — callable
///         during Registering or Running phases. Cancelled/Finalized phases
///         route refunds through `claimRefund` / `claimPayout` instead.
///
///         Unlike claim*, ownership of the agent NFT is NOT required —
///         `msg.sender` only needs to match the original depositor (the slot
///         is keyed on `pendingDeposit[T][msg.sender][agentId]`).
export async function pokerWithdrawPendingDepositHandler(args: {
  depositor: string;
  tournamentId: string;
  agentId: string;
}) {
  // audit 2026-05-22 MC-09 — runtime adres doğrulama.
  const depositor = validateAddress(args.depositor);
  if (!depositor) {
    return errorResult(err("E_INVALID_ADDRESS", "depositor must be a valid 0x-prefixed 20-byte address"));
  }
  const tournamentId = args.tournamentId as `0x${string}`;

  if (depositor === "0x0000000000000000000000000000000000000000") {
    return errorResult(err("E_INVALID_DEPOSITOR", "depositor address cannot be zero"));
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
    functionName: "withdrawPendingDeposit",
    args: [tournamentId, agentId],
  });

  return okResult({
    unsignedTxs: [
      {
        step: 1,
        purpose: "Orchestrator withdrawPendingDeposit — recover unconsumed prepay slot",
        to: config.pokerOrchestrator,
        data,
        value: "0",
        chainId: config.arcChainId,
      },
    ],
    depositor,
    tournamentId,
    agentId: agentId.toString(),
    note: "Signer wallet MUST equal the original depositor. Allowed during Registering or Running phases. Reverts with NothingToWithdraw if the slot is empty or already consumed by register.",
  });
}
