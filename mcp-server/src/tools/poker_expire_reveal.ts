// poker_expire_reveal — F-05 liveness (Codex end-user audit 2026-05-25).
//
// Anyone-callable wrapper for BetSystem.expireReveal(tableId). Defaults a
// missed reveal after commitDeadline (60s window) has passed:
//   - bet pending (toCall > 0) → Fold
//   - no bet pending           → Check
// Caller need not be the original committer — any party can rescue a frozen
// commit-reveal round. This is the commit-reveal mode's mainnet liveness rail.
//
// Mirrors poker_expire_action semantics; the only difference is which deadline
// is consumed (commitDeadline here vs actionDeadline there) and the K5 streak
// reason tag ("reveal-timeout" vs "act-timeout"). Pre-flight checks the right
// deadline so the keeper/brain doesn't burn gas on RevealNotExpired reverts.

import { encodeFunctionData } from "viem";
import { config } from "../config.js";
import { PokerBetAbi } from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";
import { arcClient, readContractWithRetry } from "../chains.js";

export async function pokerExpireRevealHandler(args: { tableId: string }) {
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66 || !tableId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex"));
  }

  // Pre-flight — commitDeadline armed and in the past. Cheap (single view).
  try {
    const deadline = (await readContractWithRetry({
      address: config.pokerBet as `0x${string}`,
      abi: PokerBetAbi,
      functionName: "commitDeadline",
      args: [tableId],
    })) as bigint;
    if (deadline === 0n) {
      return errorResult(
        err(
          "E_DEADLINE_NOT_ARMED",
          "commitDeadline=0; no pending commit to expire. If a betting round is stuck, use poker_expire_action.",
        ),
      );
    }
    const head = await arcClient.getBlock({ blockTag: "latest" });
    if (head.timestamp < deadline) {
      return errorResult(
        err(
          "E_DEADLINE_NOT_EXPIRED",
          `commitDeadline=${deadline} > head.timestamp=${head.timestamp}; broadcast would revert RevealNotExpired`,
          { deadline: deadline.toString(), headTimestamp: head.timestamp.toString() },
        ),
      );
    }
  } catch (e) {
    void e;
  }

  const data = encodeFunctionData({
    abi: PokerBetAbi,
    functionName: "expireReveal",
    args: [tableId],
  });

  return okResult({
    unsignedTx: {
      to: config.pokerBet,
      data,
      value: "0",
      chainId: config.arcChainId,
      // gas floor (mirrors poker_reveal_action / poker_invoke_showdown) — expireReveal
      // defaults the action through the same _doAct path, which SETTLES a hand-ending
      // fold (heads-up); Arc estimateGas under-counts that settlement branch and the tx
      // OOG-reverts. 2.5M is a free ceiling (only gasUsed is billed).
      gas: "2500000",
    },
    tableId,
    note:
      "Broadcast BetSystem.expireReveal. Anyone-callable. Mirrors expireAction semantics " +
      "(Fold if pending bet, Check otherwise) for missed commit-reveal reveals. Clears " +
      "pendingCommit/pendingCommitter/commitDeadline + emits RevealExpired + ReputationDelta(-10). " +
      "3rd consecutive timeout slashes -50. Reverts: CommitRevealNotEnabled, NoCommitPending, " +
      "RevealNotExpired (deadline in future), RoundAlreadyComplete, NoCurrentActor.",
  });
}
