// poker_invoke_showdown — bound-table showdown trigger.
//
// 2026-05-24 (Codex mainnet readiness item 3 B-2 desteği) — şu ana dek smoke
// invokeShowdown'u admin DEPLOYER_PK ile çağırıyordu, üretim agent path'inde
// karşılığı yoktu. ShowdownInvoker kontratı (satır 87-89) `external` + access-
// control'sız ("Anyone can call") tasarlandığı için her agent çağırabilir;
// production state-machine dealer-agent ile bu tool'u çağırır.
//
// 2026-05-25 (Claude P0 audit fix) — phase check alone is insufficient. If any
// hole card lacks the non-owner threshold (N-1 shares) or its owner-share, or
// any community card is unrevealed, ShowdownInvoker._recoverPlaintext now
// reverts ShareThresholdNotMet (was: misleading PlaintextNotInDeck via silent
// (0,0) summing). Preflight reads every required threshold in parallel — if
// any card is short, refuse to build the tx and tell the caller exactly which
// card is missing.
//
// Gas hardcode: bound table threshold-branch fonksiyonu — viem estimateGas
// state-dependent (decrypt batch'leri sırasında dalgalı) → reference_endhand_gas_cap.md
// pattern'iyle 1_500_000 üst sınır. R-F3.11 canlı kanıt: 1.13-1.43M arası (eski
// 15M hardcode'u %7.5'i), 1.5M güvenli buffer.

import { encodeFunctionData } from "viem";
import { readContractWithRetry } from "../chains.js";
import { config } from "../config.js";
import {
  PokerTableAbi,
  PokerDealAbi,
  PokerDecryptAbi,
  PokerShowdownInvokerAbi,
  TablePhase,
  TablePhaseLabel,
} from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";

type TableTuple = {
  phase: number;
  handNumber: bigint;
};

type MissingShare = {
  cardIdx: number;
  role: "hole" | "community";
  reason: string;
};

/**
 * Pure showdown-preflight gap computation (extracted for unit testing — the
 * handler's RPC reads are not mockable in the unit env, so the decision logic
 * is isolated here). Mirrors agent-runner FIX 5c + ShowdownInvoker
 * `_buildShowdownInputs`: a hole card whose SEAT is forfeited (this card OR its
 * sibling cardIdx±N has ownerShareForfeited=true) is a FORCED FOLD and needs
 * NEITHER its non-owner shares NOR its owner share — so it must be SKIPPED, not
 * reported as a gap. Without this, a legal expireOwnerShare (the absent-owner
 * liveness rail) would deadlock invokeShowdown (Codex 2026-06-04 B1).
 *
 * @param holeReads      per hole card: [shareCount, ownerShareSubmitted, ownerShareForfeited]
 * @param communityReads per community card: [shareCount, revealed]
 */
export function computeShowdownMissingShares(params: {
  N: number;
  holeIdxs: number[];
  communityIdxs: number[];
  holeReads: [number, boolean, boolean][];
  communityReads: [number, boolean][];
}): MissingShare[] {
  const { N, holeIdxs, communityIdxs, holeReads, communityReads } = params;
  const holeNonOwnerThreshold = N - 1;
  const missing: MissingShare[] = [];

  const forfeitedHoleIdx = new Set<number>();
  for (let i = 0; i < holeIdxs.length; i++) {
    if (holeReads[i][2] /* ownerShareForfeited */) forfeitedHoleIdx.add(holeIdxs[i]);
  }
  const seatForfeited = (cardIdx: number): boolean => {
    const sibling = cardIdx < N ? cardIdx + N : cardIdx - N;
    return forfeitedHoleIdx.has(cardIdx) || forfeitedHoleIdx.has(sibling);
  };

  for (let i = 0; i < holeIdxs.length; i++) {
    const idx = holeIdxs[i];
    const [shareCount, ownerShareSubmitted] = holeReads[i];
    // Forfeited seat → forced fold, needs none of its shares. Skip both this
    // card and (via seatForfeited) its sibling so the liveness rail can finalize.
    if (seatForfeited(idx)) continue;
    if (shareCount < holeNonOwnerThreshold) {
      missing.push({
        cardIdx: idx,
        role: "hole",
        reason: `shareCount=${shareCount}/${holeNonOwnerThreshold}`,
      });
    }
    if (!ownerShareSubmitted) {
      missing.push({ cardIdx: idx, role: "hole", reason: "ownerShareSubmitted=false" });
    }
  }
  for (let i = 0; i < communityIdxs.length; i++) {
    const idx = communityIdxs[i];
    const [shareCount, revealed] = communityReads[i];
    if (!revealed) {
      missing.push({
        cardIdx: idx,
        role: "community",
        reason: `revealed=false (shareCount=${shareCount}/${N})`,
      });
    }
  }
  return missing;
}

export async function pokerInvokeShowdownHandler(args: {
  tableId: string;
}) {
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66 || !tableId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex"));
  }

  // Parallel reads — table phase + active hand roster are independent.
  let table: TableTuple;
  let handRoster: readonly number[];
  try {
    const [t, hr] = await Promise.all([
      readContractWithRetry({
        address: config.pokerTable as `0x${string}`,
        abi: PokerTableAbi,
        functionName: "getTable",
        args: [tableId],
      }) as Promise<TableTuple>,
      readContractWithRetry({
        address: config.pokerDeal as `0x${string}`,
        abi: PokerDealAbi,
        functionName: "handRoster",
        args: [tableId],
      }) as Promise<readonly number[]>,
    ]);
    table = t;
    handRoster = hr;
  } catch (e) {
    return errorResult(err("E_READ_FAILED", `parallel reads failed: ${(e as Error).message}`));
  }

  if (table.phase !== TablePhase.Showdown) {
    return errorResult(
      err(
        "E_PHASE_INVALID",
        `Phase=${TablePhaseLabel[table.phase] ?? table.phase} — invokeShowdown requires Showdown. ` +
          `Run poker_advance_phase to bring the table from River → Showdown first; community-card decrypt for the showdown phase must already be complete.`,
      ),
    );
  }

  const N = handRoster.length;
  if (N === 0) {
    return errorResult(
      err(
        "E_DEAL_NOT_INITIALIZED",
        "handRoster empty — DealSystem.initDeal must precede invokeShowdown",
      ),
    );
  }

  // Hole card layout (DealSystem.sol _dealRoleOf): indices 0..2N-1 are hole
  // cards. Community spread across Preflop→Flop/Turn/River; Showdown means
  // all three reveals already happened, so we check every community slot.
  const holeEnd = 2 * N;
  const holeIdxs: number[] = [];
  for (let i = 0; i < holeEnd; i++) holeIdxs.push(i);
  // Flop (3): holeEnd+1..+3 / Turn: holeEnd+5 / River: holeEnd+7
  const communityIdxs = [holeEnd + 1, holeEnd + 2, holeEnd + 3, holeEnd + 5, holeEnd + 7];

  // Parallel: shareCount + ownerShareSubmitted + ownerShareForfeited for hole;
  // shareCount + revealed for community. ShowdownInvoker._recoverPlaintext will
  // revert if shareCount < required (community=N, hole=N-1) — surface that
  // before broadcasting. ownerShareForfeited is read so a legally-forfeited seat
  // (the absent-owner liveness rail) is NOT mistaken for a missing share.
  let holeReads: [number, boolean, boolean][];
  let communityReads: [number, boolean][];
  try {
    const holeP = Promise.all(
      holeIdxs.map((idx) =>
        Promise.all([
          readContractWithRetry({
            address: config.pokerDecrypt as `0x${string}`,
            abi: PokerDecryptAbi,
            functionName: "shareCount",
            args: [tableId, idx],
          }) as Promise<number>,
          readContractWithRetry({
            address: config.pokerDecrypt as `0x${string}`,
            abi: PokerDecryptAbi,
            functionName: "ownerShareSubmitted",
            args: [tableId, idx],
          }) as Promise<boolean>,
          readContractWithRetry({
            address: config.pokerDecrypt as `0x${string}`,
            abi: PokerDecryptAbi,
            functionName: "ownerShareForfeited",
            args: [tableId, idx],
          }) as Promise<boolean>,
        ]),
      ),
    );
    const commP = Promise.all(
      communityIdxs.map((idx) =>
        Promise.all([
          readContractWithRetry({
            address: config.pokerDecrypt as `0x${string}`,
            abi: PokerDecryptAbi,
            functionName: "shareCount",
            args: [tableId, idx],
          }) as Promise<number>,
          readContractWithRetry({
            address: config.pokerDecrypt as `0x${string}`,
            abi: PokerDecryptAbi,
            functionName: "revealed",
            args: [tableId, idx],
          }) as Promise<boolean>,
        ]),
      ),
    );
    [holeReads, communityReads] = await Promise.all([holeP, commP]);
  } catch (e) {
    return errorResult(
      err("E_DECRYPT_READ", `parallel share/owner reads failed: ${(e as Error).message}`),
    );
  }

  const holeNonOwnerThreshold = N - 1;
  // Forfeited-seat skip (Codex 2026-06-04 B1) lives in the pure helper so it is
  // unit-tested without RPC mocking.
  const missing = computeShowdownMissingShares({
    N,
    holeIdxs,
    communityIdxs,
    holeReads,
    communityReads,
  });

  if (missing.length > 0) {
    const head = missing
      .slice(0, 6)
      .map((m) => `[${m.role}#${m.cardIdx}: ${m.reason}]`)
      .join(" ");
    const tail = missing.length > 6 ? ` …(+${missing.length - 6} more)` : "";
    return errorResult(
      err(
        "E_DECRYPT_QUORUM_NOT_MET",
        `Showdown preflight: ${missing.length} card share gap(s). ${head}${tail}. ` +
          `ShowdownInvoker.invokeShowdown would revert ShareThresholdNotMet — complete reveal first.`,
        { missing, N, holeNonOwnerThreshold },
      ),
    );
  }

  const data = encodeFunctionData({
    abi: PokerShowdownInvokerAbi,
    functionName: "invokeShowdown",
    args: [tableId],
  });

  return okResult({
    tableId,
    handNumber: table.handNumber.toString(),
    phase: table.phase,
    phaseLabel: TablePhaseLabel[table.phase],
    unsignedTx: {
      to: config.pokerShowdownInvoker,
      data,
      value: "0",
      chainId: config.arcChainId,
      // Bound-table threshold-branch — caller (orchestrator/agent) should
      // respect this gas cap; estimateGas during decrypt batches has been
      // observed to undershoot. R-F3.11 mined gas was 1.13-1.43M (pre-C-02).
      // 2026-05-28 — cap 1.5M → 2.5M. C-02 fix (_buildShowdownInputs per-hole-
      // card ownerShareForfeited check) eski baseline'a ~500-700K ekledi;
      // 4-agent smoke 2026-05-28 Hand 3'te 1.5M OOG revert loop'u kanıtladı
      // (12 tx hepsi gas=1499103). 2.5M = baseline × 1.5 + C-02 overhead +
      // mainnet safety buffer.
      gas: "2500000",
      label: "ShowdownInvoker.invokeShowdown",
    },
    note:
      "Broadcast with your own PK — ShowdownInvoker.invokeShowdown is 'Anyone can call' (no admin gate). " +
      "After inclusion: ShowdownInvoked event emits the roster/holeCards/community/payouts and TableSystem.endHand fires from inside the call (gas=2.5M includes the cascade + C-02 ownerShareForfeited check).",
  });
}
