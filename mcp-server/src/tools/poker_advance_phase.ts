// poker_advance_phase — coordinator-side phase transition.
//
// Call after BetSystem.RoundState.roundComplete=true. When the HandFlowRouter is
// configured (config.pokerHandFlowRouter set — the production + Path-B default),
// this returns a SINGLE routed unsignedTx (HandFlowRouter.advancePhaseAndInitRound)
// for EVERY transition, including River → Showdown:
//
//   Preflop → Flop / Flop → Turn / Turn → River : router advances + inits round
//   River   → Showdown                          : router advances (skips initRound)
//
// The router is EOA-callable (dealer-first / seated-fallback, or any caller once
// the round is complete + currentActor==0xFF). This is the ONLY EOA path —
// 2026-06-22 (FIX-B): the prior tooling only routed when the NEXT phase was a
// betting round, so River → Showdown fell through to the bare TableSystem.advancePhase
// below, which is `onlyAuthorizedSystem` and REVERTS NotAuthorized for a plain EOA
// → Path B bricked at showdown.
//
// Fallback (router unset only): bare [TableSystem.advancePhase (+ BetSystem.initRound
// for Flop/Turn/River)] — both enforce `onlyAuthorizedSystem(tableId)` (admin /
// authorizeSystem'd). Showdown / Complete → rejected (E_PHASE_TERMINAL); the
// showdown invoker (B3.7.E / poker_invoke_showdown) handles those.
//
// 2026-05-10 — Phase ordering fix. Earlier tooling refused to emit until the
// next phase's community cards were already revealed; that contradicted the
// contract's C-02B audit fix (2026-05-08 / 2026-05-10), which now rejects
// community-card decrypt while `phase < Flop/Turn/River`. Decrypt now MUST
// happen AFTER advancePhase, so the only pre-check left is roundComplete.
// `force=true` skips that one check — useful for diagnostic broadcasts but
// dangerous in normal operation.

import { encodeFunctionData } from "viem";
import { readContractWithRetry } from "../chains.js";
import { config } from "../config.js";
import {
  PokerTableAbi,
  PokerBetAbi,
  PokerDealAbi,
  PokerHandFlowRouterAbi,
  TablePhase,
  TablePhaseLabel,
  communityCardIdxsForNextPhase,
  nextPhaseAfter,
} from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";

type TableTuple = {
  occupiedCount: number;
  phase: number;
  handNumber: bigint;
};

type RoundTuple = {
  roundComplete: boolean;
};

export type AdvanceTx = {
  to: string;
  data: `0x${string}`;
  value: string;
  chainId: number;
  label: string;
};

/**
 * Pure routing decision for poker_advance_phase (FIX-B, 2026-06-22). Returns the
 * unsignedTx(s) to broadcast. The load-bearing invariant: when a HandFlowRouter
 * is configured, EVERY transition — including River → Showdown — routes through
 * the EOA-callable HandFlowRouter.advancePhaseAndInitRound, NOT the bare
 * onlyAuthorizedSystem TableSystem.advancePhase (which reverts NotAuthorized for a
 * plain EOA). The router internally inits the next betting round for Flop/Turn/River
 * and skips initRound at Showdown, so it is safe for River → Showdown too. The
 * bare-TableSystem path is a backward-compat fallback ONLY when `router` is unset.
 * Exported pure so the routing can be unit-tested without a live chain.
 */
export function buildAdvanceUnsignedTxs(opts: {
  tableId: `0x${string}`;
  fromLabel: string;
  toLabel: string;
  isBettingRoundNext: boolean;
  router: `0x${string}` | undefined;
  tableSystem: string;
  betSystem: string;
  arcChainId: number;
}): AdvanceTx[] {
  const { tableId, fromLabel, toLabel, isBettingRoundNext, router, tableSystem, betSystem, arcChainId } = opts;
  if (router) {
    return [
      {
        to: router,
        data: encodeFunctionData({
          abi: PokerHandFlowRouterAbi,
          functionName: "advancePhaseAndInitRound",
          args: [tableId],
        }),
        value: "0",
        chainId: arcChainId,
        label: `HandFlowRouter.advancePhaseAndInitRound (${fromLabel} → ${toLabel})`,
      },
    ];
  }
  // Fallback (router unset): bare TableSystem.advancePhase (+ BetSystem.initRound
  // for Flop/Turn/River). onlyAuthorizedSystem — reverts NotAuthorized for an EOA.
  const txs: AdvanceTx[] = [
    {
      to: tableSystem,
      data: encodeFunctionData({ abi: PokerTableAbi, functionName: "advancePhase", args: [tableId] }),
      value: "0",
      chainId: arcChainId,
      label: `TableSystem.advancePhase (${fromLabel} → ${toLabel})`,
    },
  ];
  if (isBettingRoundNext) {
    txs.push({
      to: betSystem,
      data: encodeFunctionData({ abi: PokerBetAbi, functionName: "initRound", args: [tableId] }),
      value: "0",
      chainId: arcChainId,
      label: `BetSystem.initRound (${toLabel})`,
    });
  }
  return txs;
}

export async function pokerAdvancePhaseHandler(args: {
  tableId: string;
  /** Skip roundComplete + revealed checks. Default false. Requires env flag. */
  force?: boolean;
}) {
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66 || !tableId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex"));
  }
  // audit 2026-05-22 Vuln 5 — `force=true` tek-off-chain-guard'ı atlıyordu;
  // MCP katmanında yetki/rol kontrolü yok → herhangi bir çağırıcı betting
  // round bitmeden faz ilerletip rakibin son aksiyonunu yutabilirdi. Artık
  // env-flag (POKER_ALLOW_FORCE_ADVANCE=1) zorunlu; diagnostic kullanımı için
  // ayrı çevre değişkeni, normal production'da fiilen kapalı.
  const force = args.force === true;
  if (force && process.env.POKER_ALLOW_FORCE_ADVANCE !== "1") {
    return errorResult(
      err(
        "E_FORCE_DISABLED",
        "force=true requires POKER_ALLOW_FORCE_ADVANCE=1 env flag — diagnostic only, not for production.",
      ),
    );
  }

  // 1. Read current phase + active hand roster + round state in parallel.
  //    G14 — community card index math uses DealSystem.handRoster (chips>0
  //    snapshot at initDeal), NOT TableSystem.occupiedSeats (still includes
  //    eliminated seats). DecryptSystem._dealRoleOf classifies by handRoster
  //    length too; off-chain MUST mirror that or we wait for the wrong slots.
  //    2026-05-10 — PokerDecryptAbi no longer needed here (revealed[] check
  //    removed); kept inline only for tx encoding when DecryptSystem is reached
  //    elsewhere.
  // audit 2026-05-22 MC-11 — readContractWithRetry explicit (RPC blip yutar);
  // üst-düzey try/catch zaten mevcuttu.
  let table: TableTuple;
  let round: RoundTuple;
  let handRoster: readonly number[];
  try {
    const [t, r, hr] = await Promise.all([
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
        address: config.pokerDeal as `0x${string}`,
        abi: PokerDealAbi,
        functionName: "handRoster",
        args: [tableId],
      }) as Promise<readonly number[]>,
    ]);
    table = t;
    round = r;
    handRoster = hr;
  } catch (e) {
    return errorResult(err("E_READ_FAILED", `state reads failed: ${(e as Error).message}`));
  }

  const phase = table.phase;
  const N = handRoster.length;

  // 2. Reject terminal/illegal phases. Showdown invocation is B3.7.E's job;
  //    auto-advancing River → Showdown is fine, but Showdown → Complete should
  //    flow through ShowdownSystem.endHand callback, not advancePhase.
  if (phase === TablePhase.WaitingForPlayers) {
    return errorResult(
      err(
        "E_PHASE_INVALID",
        "Phase=WaitingForPlayers — startHand must run first; advancePhase has nothing to advance.",
      ),
    );
  }
  if (phase === TablePhase.Showdown || phase === TablePhase.Complete) {
    return errorResult(
      err(
        "E_PHASE_TERMINAL",
        `Phase=${TablePhaseLabel[phase]} — showdown invoker (B3.7.E) and endHand handle this transition, not poker_advance_phase.`,
      ),
    );
  }

  const nextPhase = nextPhaseAfter(phase);
  const communityCardIdxs = communityCardIdxsForNextPhase(phase, N);

  // 3. Strict check — only roundComplete (skip if force=true).
  //
  //    2026-05-10 — revealed[] community-card pre-check kaldirildi. Eski mantik:
  //    "decrypt → advancePhase" (kart acilmadan phase ilerletilmesin). Yeni
  //    kontrat C-02B audit fix (2026-05-08 / 2026-05-10) ile decrypt phase >=
  //    Flop/Turn/River bekliyor → advancePhase decrypt'ten ONCE cagrilmali.
  //    Off-chain validation kontrat ile cakisiyordu (smoke deadlock); doğru
  //    siralama kontrat tarafinda zorunlu kilindigi icin tek pre-check
  //    roundComplete kaldi. Reveal sirasi: roundComplete -> advancePhase ->
  //    decrypt_share (community cards) -> next round.
  if (!force) {
    if (!round.roundComplete) {
      return errorResult(
        err(
          "E_ROUND_NOT_COMPLETE",
          `BetSystem.RoundState.roundComplete=false for handNumber ${table.handNumber}. Wait for the betting round to finish before advancing.`,
        ),
      );
    }
  }

  // 4. Build txs.
  // initRound only when transitioning into a betting round (Flop/Turn/River).
  // River → Showdown is a non-betting transition; ShowdownSystem takes over.
  const isBettingRoundNext =
    nextPhase === TablePhase.Flop ||
    nextPhase === TablePhase.Turn ||
    nextPhase === TablePhase.River;

  // 2026-06-22 (Path B build, FIX-B / adversarial-review HIGH) — ALWAYS route
  // through the HandFlowRouter when it is configured, for EVERY phase including
  // River → Showdown. The bare `TableSystem.advancePhase` is `onlyAuthorizedSystem`
  // and REVERTS NotAuthorized for a plain EOA; only the router is EOA-callable
  // (dealer/fallback, or any caller once the round is complete + currentActor==0xFF).
  // Production tryAdvancePhase (hand-state-machine.ts) ALWAYS calls
  // advancePhaseAndInitRound for every phase < Showdown — the previous
  // `isBettingRoundNext` gate meant River → Showdown fell through to the bare
  // admin-only call and bricked Path B. The router internally calls bet.initRound
  // ONLY for Flop/Turn/River and correctly SKIPS it at Showdown
  // (HandFlowRouter.sol:122-128), so it is safe for River → Showdown too. The
  // bare-TableSystem path is kept ONLY as a backward-compat fallback (router unset).
  const router = config.pokerHandFlowRouter;
  const unsignedTxs = buildAdvanceUnsignedTxs({
    tableId,
    fromLabel: TablePhaseLabel[phase],
    toLabel: TablePhaseLabel[nextPhase],
    isBettingRoundNext,
    router,
    tableSystem: config.pokerTable,
    betSystem: config.pokerBet,
    arcChainId: config.arcChainId,
  });

  let note: string;
  if (router) {
    note = isBettingRoundNext
      ? `Broadcast the routed tx. It calls TableSystem.advancePhase and BetSystem.initRound atomically for ${TablePhaseLabel[nextPhase]}.`
      : `Broadcast the routed tx. It calls TableSystem.advancePhase for ${TablePhaseLabel[nextPhase]} (River → Showdown — no betting round init; the router skips initRound at Showdown). Showdown invocation is poker_invoke_showdown's job.`;
  } else {
    note = isBettingRoundNext
      ? `Broadcast txs in order. After both land, ${TablePhaseLabel[nextPhase]} betting round is open and currentActor is set to the first post-flop actor.`
      : `Broadcast the advancePhase tx. ${TablePhaseLabel[nextPhase]} requires the showdown invoker (B3.7.E) — currentActor is cleared (0xFF).`;
  }

  return okResult({
    tableId,
    fromPhase: phase,
    fromPhaseLabel: TablePhaseLabel[phase],
    toPhase: nextPhase,
    toPhaseLabel: TablePhaseLabel[nextPhase],
    handNumber: table.handNumber.toString(),
    occupiedCount: N,
    communityCardIdxs,
    isBettingRoundNext,
    txCount: unsignedTxs.length,
    unsignedTxs,
    note,
  });
}
