// poker_retry_tournament_finalize — C-03 fix (Codex mainnet-readiness audit
// 2026-05-26).
//
// Anyone-callable wrapper for TableSystem.retryTournamentFinalize. The
// trust-minimized finalize callback (`_triggerFinalize` /
// `_triggerFinalizeByChipStack`) is wrapped in try/catch on the table
// side: if the orchestrator reverts (registered-no-show pruning needed,
// transient nonReentrant lock, etc.), the ranking is parked and ANY
// caller may flush it via this tool once the orchestrator-side condition
// clears. Without this rail a transient revert would strand the
// tournament in `Running` even though the table is `Complete` — only
// operator/upgrade intervention could drain the prize pool.
//
// Preflight: optional — we just need a valid 32-byte tableId.

import { encodeFunctionData, parseAbi } from "viem";
import { config } from "../config.js";
import { okResult, errorResult, err } from "../errors.js";
import { readContractWithRetry } from "../chains.js";

const ABI = parseAbi([
  "function retryTournamentFinalize(bytes32 tableId)",
  "function pendingFinalizeTournament(bytes32) view returns (bytes32)",
  "function pendingFinalizeRanking(bytes32) view returns (uint256[])",
] as const);

type Args = { tableId: string };

export async function pokerRetryTournamentFinalizeHandler(args: Args) {
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66 || !tableId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex"));
  }

  // Pre-flight — confirm a finalize is actually pending. Bail with a
  // clearer error than the on-chain revert (`NoPendingFinalize`) when
  // there's nothing to retry. Read failure is non-fatal — the broadcast
  // still goes; the contract enforces the rule.
  try {
    const pendingTournamentId = (await readContractWithRetry({
      address: config.pokerTable as `0x${string}`,
      abi: ABI,
      functionName: "pendingFinalizeTournament",
      args: [tableId],
    })) as `0x${string}`;
    if (
      pendingTournamentId ===
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    ) {
      return errorResult(
        err(
          "E_NO_PENDING_FINALIZE",
          "TableSystem.pendingFinalizeTournament(tableId) == 0x0; no parked ranking to retry. " +
            "Either the callback succeeded on first try (nothing to do) or _triggerFinalize " +
            "was never invoked for this table (no single-survivor + no MAX_HANDS cap hit).",
        ),
      );
    }
  } catch (e) {
    void e;
  }

  const data = encodeFunctionData({
    abi: ABI,
    functionName: "retryTournamentFinalize",
    args: [tableId],
  });

  return okResult({
    unsignedTx: {
      to: config.pokerTable,
      data,
      value: "0",
      chainId: config.arcChainId,
    },
    tableId,
    note:
      "Broadcast TableSystem.retryTournamentFinalize. Anyone-callable. " +
      "Re-flushes the parked finalize ranking through the bound " +
      "orchestrator. Success clears the pending state (further retries " +
      "revert NoPendingFinalize); failure leaves the parking state " +
      "intact and emits TournamentFinalizeCallbackFailed with the latest " +
      "revert reason. Use when an upstream condition that caused the " +
      "first callback to revert has been resolved (e.g. expireUnseated " +
      "pruned a registered no-show, an unrelated reentrancy lock " +
      "released).",
  });
}
