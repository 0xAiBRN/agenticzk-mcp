// poker_expire_action — F-05 liveness (Codex end-user audit 2026-05-25).
//
// Anyone-callable wrapper for BetSystem.expireAction(tableId). Defaults the
// currentActor's missed turn after actionDeadline has passed:
//   - bet pending (toCall > 0) → Fold
//   - no bet pending           → Check
// Caller need not be the stuck actor — a spectator, another agent, or a
// permissionless keeper can unstick a frozen betting round. This is the
// production agent's mainnet liveness rail; without it a single offline
// agent freezes the table indefinitely and the tournament cannot finalize.
//
// The contract performs all preconditions (deadline expiry, no pending
// commit, seat is actionable). Pre-flight here is minimal: we only check
// that the deadline is armed AND in the past, so the brain/keeper doesn't
// burn gas on a tx the contract would immediately revert (`ActionNotExpired`).

import { encodeFunctionData } from "viem";
import { config } from "../config.js";
import { PokerBetAbi } from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";
import { arcClient, readContractWithRetry } from "../chains.js";

export async function pokerExpireActionHandler(args: { tableId: string }) {
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66 || !tableId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex"));
  }

  // Pre-flight — actionDeadline armed and in the past. Cheap (single view).
  try {
    const deadline = (await readContractWithRetry({
      address: config.pokerBet as `0x${string}`,
      abi: PokerBetAbi,
      functionName: "actionDeadline",
      args: [tableId],
    })) as bigint;
    if (deadline === 0n) {
      return errorResult(
        err(
          "E_DEADLINE_NOT_ARMED",
          "actionDeadline=0; nothing to expire (no actionable currentActor or commit-reveal is pending — use poker_expire_reveal in that case)",
        ),
      );
    }
    const head = await arcClient.getBlock({ blockTag: "latest" });
    if (head.timestamp < deadline) {
      return errorResult(
        err(
          "E_DEADLINE_NOT_EXPIRED",
          `actionDeadline=${deadline} > head.timestamp=${head.timestamp}; broadcast would revert ActionNotExpired`,
          { deadline: deadline.toString(), headTimestamp: head.timestamp.toString() },
        ),
      );
    }
  } catch (e) {
    // Non-fatal — if the preflight read fails, fall through. The contract
    // still enforces the deadline on broadcast. (RPC blips covered by retry.)
    void e;
  }

  const data = encodeFunctionData({
    abi: PokerBetAbi,
    functionName: "expireAction",
    args: [tableId],
  });

  return okResult({
    unsignedTx: {
      to: config.pokerBet,
      data,
      value: "0",
      chainId: config.arcChainId,
      // gas floor (mirrors poker_reveal_action / poker_expire_reveal / poker_invoke_showdown)
      // — expireAction routes the default through the same _doAct + _postAct path, which
      // SETTLES a hand-ending fold (heads-up); Arc estimateGas under-counts that settlement
      // branch. 2.5M is a free ceiling (only gasUsed is billed).
      gas: "2500000",
    },
    tableId,
    note:
      "Broadcast BetSystem.expireAction (gas 2.5M). Anyone-callable. K9 default: bet pending → Fold, " +
      "no bet → Check. Emits Acted + ActionExpired + ReputationDelta(-10). 3rd consecutive " +
      "timeout slashes -50 + flags the seat. Round advancement / next actor / deadline reset " +
      "flow through the standard _postAct path. Reverts: ActionNotExpired (deadline in future), " +
      "StaleCommitPresent (use poker_expire_reveal), RoundAlreadyComplete, NoCurrentActor.",
  });
}
