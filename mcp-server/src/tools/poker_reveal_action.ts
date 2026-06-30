// poker_reveal_action — MS-5 K2 commit-reveal MEV protection, reveal half.
//
// Second tx of the commit-reveal flow (see poker_commit_action for the why).
// Caller supplies the same (action, amount, salt) they committed; BetSystem
// recomputes the hash, asserts it matches `pendingCommit[tableId]`, then
// executes the action via the regular _doAct path.
//
// This tool is intentionally thin — almost no pre-flight. The contract is the
// source of truth for the commit/reveal matching; off-chain re-validation here
// would just duplicate the on-chain hash compare and could drift.
//
// audit 2026-05-22 AP-06 #12 — yeni tool, commit-reveal'in MCP yüzeyi.

import { encodeFunctionData } from "viem";
import { config } from "../config.js";
import { PokerBetAbi, PokerActionEnum, type PokerActionLabel } from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";
import { arcClient, readContractWithRetry } from "../chains.js";

export async function pokerRevealActionHandler(args: {
  tableId: string;
  action: string;
  amount?: string;
  salt: string;
  /** Codex P1-4 backup defense — caller (e.g. agent-runner state-machine)
   *  may supply the commit tx's receipt blockNumber. If set, this tool
   *  reads the chain head once and returns E_STALE_HEAD when head < minBlock,
   *  so a misconfigured caller that skipped the agent-runner barrier still
   *  refuses to broadcast a reveal against a stale-state node. Optional. */
  minBlock?: string;
}) {
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66 || !tableId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex"));
  }

  const rawLabel = args.action.toLowerCase();
  const label = rawLabel as PokerActionLabel;
  const enumValue = PokerActionEnum[label];
  if (enumValue === undefined) {
    return errorResult(
      err("E_INVALID_ACTION", `action must be one of: fold, check, call, raise (got '${args.action}')`),
    );
  }

  if (!args.salt || !/^0x[0-9a-fA-F]{64}$/.test(args.salt)) {
    return errorResult(err("E_INVALID_SALT", "salt must be 32-byte hex (0x + 64 chars)"));
  }
  const salt = args.salt as `0x${string}`;

  // audit 2026-05-22 MC-10 — BigInt try/catch.
  let amount: bigint;
  try {
    amount = BigInt(args.amount ?? "0");
  } catch {
    return errorResult(err("E_INVALID_AMOUNT", "amount must be a numeric string"));
  }
  if (amount < 0n) {
    return errorResult(err("E_NEGATIVE_AMOUNT", "amount cannot be negative"));
  }

  // Codex P1-4 — optional defensive head-gate. Off by default (older callers
  // and tests don't pass minBlock); when set, reject if the public client's
  // current block is behind the requested floor. Single read, no polling.
  if (args.minBlock !== undefined) {
    let minBlockBig: bigint;
    try {
      minBlockBig = BigInt(args.minBlock);
    } catch {
      return errorResult(err("E_INVALID_MIN_BLOCK", "minBlock must be a numeric string"));
    }
    if (minBlockBig > 0n) {
      try {
        const head = await arcClient.getBlockNumber();
        if (head < minBlockBig) {
          return errorResult(
            err(
              "E_STALE_HEAD",
              `RPC head ${head} is behind commit block ${minBlockBig}; refusing to encode reveal (retry once head catches up)`,
            ),
          );
        }
      } catch (e) {
        return errorResult(
          err("E_RPC_HEAD_READ", `failed to read chain head for minBlock check: ${(e as Error).message?.slice(0, 160)}`),
        );
      }
    }
  }

  // Claude 2026-05-25 P1 audit — commitDeadline preflight. The 60-second
  // reveal window is a hard contract guard (BetSystem.revealAction reverts
  // CommitExpired once block.timestamp >= deadline). Without this check we
  // build + broadcast a tx that the chain instantly reverts; gas burned and
  // the brain has no diagnostic — it sees `tx failed` and re-tries the same
  // dead reveal. Single view read, fail fast.
  try {
    const deadline = (await readContractWithRetry({
      address: config.pokerBet as `0x${string}`,
      abi: PokerBetAbi,
      functionName: "commitDeadline",
      args: [tableId],
    })) as bigint;
    if (deadline > 0n) {
      const head = await arcClient.getBlock({ blockTag: "latest" });
      const headTs = head.timestamp;
      if (headTs >= deadline) {
        return errorResult(
          err(
            "E_REVEAL_WINDOW_EXPIRED",
            `commitDeadline=${deadline} <= head.timestamp=${headTs}; revealAction would revert CommitExpired. ` +
              `Anyone can now call BetSystem.expireReveal — the commit is forfeit. Do not broadcast.`,
            { deadline: deadline.toString(), headTimestamp: headTs.toString() },
          ),
        );
      }
    }
  } catch (e) {
    // Preflight failure non-fatal — if we can't read the deadline, the
    // contract still enforces it on broadcast. Surface as a non-blocking
    // warning by logging once; tool continues.
    // (Errors here would mostly be RPC blips; the retry wrapper already covers them.)
    // Intentionally swallowed.
    void e;
  }

  const data = encodeFunctionData({
    abi: PokerBetAbi,
    functionName: "revealAction",
    args: [tableId, enumValue, amount, salt],
  });

  return okResult({
    unsignedTx: {
      to: config.pokerBet,
      data,
      value: "0",
      chainId: config.arcChainId,
      // Explicit gas floor (mirrors poker_invoke_showdown's 2.5M). revealAction runs
      // the action through _doAct, which on a hand-ENDING action (a fold that leaves
      // one player in heads-up, or the last action of a betting round) settles the
      // hand — pot award + per-seat accounting. Arc's estimateGas under-counts that
      // settlement branch (same class as endHand/invokeShowdown; a heads-up fold-reveal
      // OOG'd at an estimated 213k in the 2026-06-27 skill test), so leaving gas to
      // estimation intermittently OOG-reverts the reveal. 2.5M is a free ceiling (only
      // gasUsed is billed) and matches the settlement-branch cap used elsewhere.
      gas: "2500000",
    },
    tableId,
    action: label,
    actionEnum: enumValue,
    amount: amount.toString(),
    salt,
    note:
      "Broadcast revealAction (gas 2.5M — settlement branch). BetSystem recomputes " +
      "commitHashFor(...) with the disclosed fields + on-chain handNumber + on-chain " +
      "currentBet (committed at commit time); if it matches pendingCommit[tableId], the " +
      "action runs through _doAct exactly as a single-tx `act` would. Reverts: " +
      "CommitRevealMismatch (wrong pre-image), NoCommitPending (commit not landed yet), " +
      "NotYourTurn (different committer).",
  });
}
