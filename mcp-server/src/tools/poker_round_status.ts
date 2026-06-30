// poker_round_status — aggregated read for phase-orchestration decisions.
//
// Coordinator and agents both poll this tool to answer "what should I do
// next?" without making 5+ separate read calls. It bundles:
//   - TableSystem.getTable       (phase, handNumber, currentActor, occupiedCount)
//   - TableSystem.occupiedSeats  (presentation: which seats are physically taken)
//   - DealSystem.handRoster      (G14: active hand roster — chips>0 snapshot
//                                 at initDeal time; this is the layout authority
//                                 for hole-vs-community card index math)
//   - BetSystem.getRound         (roundComplete, currentBet, lastAggressor)
//   - For each card index belonging to the *next* phase's community reveal,
//     DecryptSystem.requiredSharesFor + shareCount + revealed.
//
// The `readyToAdvance` flag captures the orchestration gate:
//   readyToAdvance = roundComplete AND (no community reveals pending
//                                       OR all listed community slots revealed)
// — i.e. it is safe to call poker_advance_phase.
//
// Notes:
//   - Returns purely view data; no tx encoded. Cheap to call repeatedly.
//   - Phase=Showdown / Complete: nextPhase still computed, but
//     communityCardIdxs is empty and readyToAdvance only reflects roundComplete.
//     Showdown invocation is B3.7.E — this tool does not auto-trigger it.

import { readContractWithRetry } from "../chains.js";
import { config } from "../config.js";
import {
  PokerTableAbi,
  PokerBetAbi,
  PokerDealAbi,
  PokerDecryptAbi,
  TablePhase,
  TablePhaseLabel,
  communityCardIdxsForNextPhase,
  nextPhaseAfter,
} from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";

type TableTuple = {
  admin: `0x${string}`;
  maxSeats: number;
  occupiedCount: number;
  smallBlind: bigint;
  bigBlind: bigint;
  minBuyIn: bigint;
  maxBuyIn: bigint;
  dealerButton: number;
  currentActor: number;
  handNumber: bigint;
  phase: number;
};

type RoundTuple = {
  handNumber: bigint;
  currentBet: bigint;
  minRaise: bigint;
  lastAggressor: number;
  actedBitmap: number;
  roundComplete: boolean;
};

export async function pokerRoundStatusHandler(args: { tableId: string }) {
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66 || !tableId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex"));
  }

  // Parallel reads — table + round + occupied roster + active hand roster are independent.
  // audit 2026-05-22 MC-11 — readContractWithRetry explicit (RPC blip yutar).
  let table: TableTuple;
  let round: RoundTuple;
  let occupied: readonly number[];
  let handRoster: readonly number[];
  try {
    const [t, r, occ, hr] = await Promise.all([
      readContractWithRetry({
        address: config.pokerTable as `0x${string}`,
        abi: PokerTableAbi,
        functionName: "getTable",
        args: [tableId],
      }) as Promise<TableTuple>,
      readContractWithRetry({
        address: config.pokerBet as `0x${string}`,
        abi: PokerBetAbi,
        functionName: "getRound",
        args: [tableId],
      }) as Promise<RoundTuple>,
      readContractWithRetry({
        address: config.pokerTable as `0x${string}`,
        abi: PokerTableAbi,
        functionName: "occupiedSeats",
        args: [tableId],
      }) as Promise<readonly number[]>,
      readContractWithRetry({
        address: config.pokerDeal as `0x${string}`,
        abi: PokerDealAbi,
        functionName: "handRoster",
        args: [tableId],
      }) as Promise<readonly number[]>,
    ]);
    table = t;
    round = r;
    occupied = occ;
    handRoster = hr;
  } catch (e) {
    return errorResult(err("E_READ_FAILED", `parallel reads failed: ${(e as Error).message}`));
  }

  // G14 — community card index math MUST use handRoster.length, not occupiedSeats.length.
  // After elimination, occupiedSeats may still hold the eliminated seat (player.chips==0
  // before next-hand cleanup) while handRoster only contains chips>0 active seats.
  // DecryptSystem._dealRoleOf uses handRoster.length for hole(2N) / burn(2N+...) /
  // community(2N+1..) classification — off-chain MUST mirror that.
  // Pre-initDeal phases (WaitingForPlayers) handRoster is empty; communityCardIdxsForNextPhase
  // returns [] in those branches anyway, so N=0 is safe.
  const N = handRoster.length;
  const phase = table.phase;
  const nextPhase = nextPhaseAfter(phase);
  const communityCardIdxs = communityCardIdxsForNextPhase(phase, N);

  // Per-slot decrypt status (parallel reads).
  let community: Array<{
    cardIdx: number;
    threshold: number;
    shareCount: number;
    revealed: boolean;
  }> = [];
  if (communityCardIdxs.length > 0) {
    try {
      const reads = communityCardIdxs.flatMap((idx) => [
        readContractWithRetry({
          address: config.pokerDecrypt as `0x${string}`,
          abi: PokerDecryptAbi,
          functionName: "requiredSharesFor",
          args: [tableId, idx],
        }) as Promise<number>,
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
      ]);
      const results = await Promise.all(reads);
      community = communityCardIdxs.map((idx, i) => ({
        cardIdx: idx,
        threshold: results[i * 3] as number,
        shareCount: results[i * 3 + 1] as number,
        revealed: results[i * 3 + 2] as boolean,
      }));
    } catch (e) {
      return errorResult(
        err("E_DECRYPT_READ", `community decrypt status read failed: ${(e as Error).message}`),
      );
    }
  }

  const allCommunityRevealed =
    communityCardIdxs.length === 0 || community.every((c) => c.revealed);
  const readyToAdvance =
    round.roundComplete &&
    phase !== TablePhase.WaitingForPlayers &&
    phase !== TablePhase.Complete &&
    allCommunityRevealed;

  // Phase-specific note for orchestration.
  let note: string;
  if (phase === TablePhase.WaitingForPlayers) {
    note = "Phase=WaitingForPlayers — call TableSystem.startHand (or poker_hand_start with withStartHand) once joint pk + initDeal land.";
  } else if (phase === TablePhase.Complete) {
    note = "Phase=Complete — hand finished. Call TableSystem.startHand for the next hand or finalize the tournament.";
  } else if (phase === TablePhase.Showdown) {
    note = "Phase=Showdown — invoke ShowdownSystem to resolve pots (B3.7.E). poker_advance_phase rejects this transition.";
  } else if (!round.roundComplete) {
    note = `Round in progress. currentActor=${table.currentActor}; toCall via poker_action with the appropriate label.`;
  } else if (!allCommunityRevealed) {
    const pending = community.filter((c) => !c.revealed).map((c) => c.cardIdx);
    note = `Round complete. Pending community reveal for cardIdx ${pending.join(", ")} — agents must run poker_decrypt_share until threshold met.`;
  } else {
    note = `Round complete and community reveal done. Coordinator calls poker_advance_phase to move ${TablePhaseLabel[phase]} → ${TablePhaseLabel[nextPhase]}.`;
  }

  return okResult({
    tableId,
    phase,
    phaseLabel: TablePhaseLabel[phase] ?? `Unknown(${phase})`,
    nextPhase,
    nextPhaseLabel: TablePhaseLabel[nextPhase] ?? `Unknown(${nextPhase})`,
    handNumber: table.handNumber.toString(),
    currentActor: table.currentActor,
    dealerButton: table.dealerButton,
    // occupiedCount kept for backwards compat — reflects active hand-roster count
    // (used by deal layout). occupiedSeats lists the physical occupancy.
    occupiedCount: N,
    occupiedSeats: occupied.map((s) => Number(s)),
    handRoster: handRoster.map((s) => Number(s)),
    handRosterCount: N,
    round: {
      handNumber: round.handNumber.toString(),
      currentBet: round.currentBet.toString(),
      minRaise: round.minRaise.toString(),
      lastAggressor: round.lastAggressor,
      actedBitmap: round.actedBitmap,
      roundComplete: round.roundComplete,
    },
    community,
    communityCardIdxs,
    allCommunityRevealed,
    readyToAdvance,
    note,
  });
}
