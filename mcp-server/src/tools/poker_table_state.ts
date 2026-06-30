import { readContractQuorum, waitHeadsAtLeast } from "../chains.js";
import { config } from "../config.js";
import { PokerTableAbi, PokerBetAbi } from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const PHASE_NAMES = [
  "WaitingForPlayers",
  "Preflop",
  "Flop",
  "Turn",
  "River",
  "Showdown",
  "Complete",
] as const;

export async function pokerTableStateHandler(args: {
  tableId: string;
  maxSeats?: number; // default 8
  /**
   * 2026-05-17 Codex Round 2 — Read-after-write barrier. Caller bir önceki
   * write tx'in receipt.blockNumber'ını burada geçirirse, MCP read'i o block'a
   * pin'ler + tüm read RPC'lerinin head'i o block'a ulaşana kadar bekler.
   * Çoklu RPC setup'unda ek olarak k-of-n quorum uygulanır.
   */
  minBlock?: string;
  /** Quorum boyutunu override et (default: ENV ARC_MCP_QUORUM_K) */
  quorumK?: number;
}) {
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex"));
  }
  const maxSeats = Math.max(2, Math.min(args.maxSeats ?? 8, 9));
  const minBlock = args.minBlock ? BigInt(args.minBlock) : 0n;
  if (minBlock > 0n) {
    try {
      await waitHeadsAtLeast(minBlock);
    } catch (e) {
      return errorResult(err("E_HEAD_WAIT_TIMEOUT", (e as Error).message));
    }
  }
  // Pinned block — quorum read aynı blocktan, race yok
  const blockNumber = minBlock > 0n ? minBlock : undefined;
  const quorumOpts = { blockNumber, k: args.quorumK };

  type RawSeat = {
    player: `0x${string}`;
    agentId: `0x${string}`;
    chips: bigint;
    occupied: boolean;
    inHand: boolean;
    folded: boolean;
    allIn: boolean;
    currentBet: bigint;
    handContribution: bigint;
  };
  type RawTable = {
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
  type SeatCall =
    | { seatIdx: number; ok: true; raw: RawSeat }
    | { seatIdx: number; ok: false };

  // Query each seat slot in parallel; empty slots come back with player == 0x0.
  // Quorum k-of-n: çoklu RPC setup'ta state-stale yakalanır.
  const seatCalls: Promise<SeatCall>[] = Array.from({ length: maxSeats }, (_, i) =>
    readContractQuorum<RawSeat>({
      address: config.pokerTable,
      abi: PokerTableAbi,
      functionName: "getSeat",
      args: [tableId, i],
    }, quorumOpts)
      .then<SeatCall>((r) => ({ seatIdx: i, ok: true, raw: r }))
      .catch<SeatCall>(() => ({ seatIdx: i, ok: false })),
  );

  const ZERO_HASH = ("0x" + "00".repeat(32)) as `0x${string}`;
  const [
    seats,
    round,
    table,
    activeSeatList,
    commitRevealEnabled,
    pendingCommitter,
    pendingCommit,
    commitDeadline,
    actionDeadline,
  ] = await Promise.all([
    Promise.all(seatCalls),
    readContractQuorum({
      address: config.pokerBet,
      abi: PokerBetAbi,
      functionName: "getRound",
      args: [tableId],
    }, quorumOpts).catch(() => null),
    readContractQuorum({
      address: config.pokerTable,
      abi: PokerTableAbi,
      functionName: "getTable",
      args: [tableId],
    }, quorumOpts).catch(() => null),
    // Canonical "still in the hand" set from the contract: occupied + inHand
    // + !folded. Cheaper + safer than recomputing from seat snapshots, since
    // the agent runner uses this to drive its action loop.
    readContractQuorum<readonly number[]>({
      address: config.pokerTable,
      abi: PokerTableAbi,
      functionName: "activeSeats",
      args: [tableId],
    }, quorumOpts).catch(() => [] as readonly number[]),
    // 2026-05-24 — production agent commit-reveal awareness (Codex mainnet
    // readiness item 1+2+3). Orchestrator orchestrator.ts'te bu flag'e bakıp
    // tx broadcast yolunu tek-tx (act) vs 2-tx (commit→reveal) arasında
    // yönlendirir. Read failure non-fatal → false varsayımı; en kötü durum
    // commit-reveal=true tabloda act revert eder + brain bir tur kaybeder
    // (brain.ts retry yolu zaten var).
    readContractQuorum<boolean>({
      address: config.pokerBet,
      abi: PokerBetAbi,
      functionName: "commitRevealEnabled",
      args: [tableId],
    }, quorumOpts).catch(() => false),
    // 2026-06-22 (Path B build, FIX-5) — commit-reveal barrier quorum reads so a
    // Path-B harness drives commit→minBlock→reveal without out-of-band cast calls.
    // COHERENT only when minBlock is passed (all reads share the pinned head);
    // without it they may straddle blocks → reveal-too-early risk (commitReveal
    // .coherentSnapshot flags this). Each non-fatal (safe default on read fail).
    readContractQuorum<`0x${string}`>({
      address: config.pokerBet, abi: PokerBetAbi, functionName: "pendingCommitter", args: [tableId],
    }, quorumOpts).catch(() => ZERO_ADDRESS as `0x${string}`),
    readContractQuorum<`0x${string}`>({
      address: config.pokerBet, abi: PokerBetAbi, functionName: "pendingCommit", args: [tableId],
    }, quorumOpts).catch(() => ZERO_HASH),
    readContractQuorum<bigint>({
      address: config.pokerBet, abi: PokerBetAbi, functionName: "commitDeadline", args: [tableId],
    }, quorumOpts).catch(() => 0n),
    readContractQuorum<bigint>({
      address: config.pokerBet, abi: PokerBetAbi, functionName: "actionDeadline", args: [tableId],
    }, quorumOpts).catch(() => 0n),
  ]);

  const occupied = seats
    .filter((s): s is Extract<SeatCall, { ok: true }> => s.ok)
    .map((s) => ({
      seatIdx: s.seatIdx,
      player: s.raw.player,
      agentId: BigInt(s.raw.agentId).toString(),
      chips: s.raw.chips.toString(),
      occupied: s.raw.occupied,
      inHand: s.raw.inHand,
      folded: s.raw.folded,
      allIn: s.raw.allIn,
      currentBet: s.raw.currentBet.toString(),
      handContribution: s.raw.handContribution.toString(),
      empty: s.raw.player === ZERO_ADDRESS,
    }));

  // Computed pot: sum of all seats' handContribution. Cheaper than calling
  // BetSystem (and works even before BetSystem state is initialised).
  const potTotal = occupied
    .filter((s) => !s.empty)
    .reduce((acc, s) => acc + BigInt(s.handContribution), 0n)
    .toString();

  const t = table as RawTable | null;
  return okResult({
    tableId,
    table: t
      ? {
          admin: t.admin,
          maxSeats: t.maxSeats,
          occupiedCount: t.occupiedCount,
          smallBlind: t.smallBlind.toString(),
          bigBlind: t.bigBlind.toString(),
          minBuyIn: t.minBuyIn.toString(),
          maxBuyIn: t.maxBuyIn.toString(),
          dealerButton: t.dealerButton,
          currentActor: t.currentActor,
          handNumber: Number(t.handNumber),
          phase: t.phase,
          phaseName: PHASE_NAMES[t.phase] ?? "Unknown",
        }
      : null,
    seats: occupied,
    activeSeats: (activeSeatList ?? []).map((idx) => Number(idx)),
    pot: potTotal,
    commitRevealEnabled: Boolean(commitRevealEnabled),
    // 2026-06-22 (Path B build, FIX-5) — commit-reveal barrier state for a
    // Path-B harness: detect pending commit, who owns it, the hash to match on
    // reveal, and the 60s deadline. Pass minBlock (the commit receipt block) for
    // a coherent snapshot before revealing.
    commitReveal: {
      enabled: Boolean(commitRevealEnabled),
      pending:
        Boolean(commitRevealEnabled) &&
        ((pendingCommit as `0x${string}`) ?? ZERO_HASH).toLowerCase() !== ZERO_HASH,
      pendingCommitter: (pendingCommitter as `0x${string}`) ?? ZERO_ADDRESS,
      pendingCommitHash: (pendingCommit as `0x${string}`) ?? ZERO_HASH,
      commitDeadline: ((commitDeadline as bigint) ?? 0n).toString(),
      actionDeadline: ((actionDeadline as bigint) ?? 0n).toString(),
      revealWindowSeconds: 60, // BetSystem REVEAL_TIMEOUT_BASE (compile-time constant)
      coherentSnapshot: minBlock > 0n, // pendingCommit/Committer coherent ONLY with minBlock pinned
    },
    // BetSystem.RoundState does not track currentPlayerSeat — that lives on
    // TableSystem.Table.currentActor (sole source of truth used by BetSystem.act
    // for seat dispatch). We surface it here under the name the agent runner
    // already reads to keep the orchestrator API stable.
    round: round
      ? {
          currentPlayerSeat: t?.currentActor ?? 0xff,
          handNumber: Number((round as { handNumber: bigint }).handNumber),
          highBet: (round as { currentBet: bigint }).currentBet.toString(),
          minRaiseAmount: (round as { minRaise: bigint }).minRaise.toString(),
          lastAggressor: (round as { lastAggressor: number }).lastAggressor,
          actedBitmap: (round as { actedBitmap: number }).actedBitmap,
          roundComplete: (round as { roundComplete: boolean }).roundComplete,
        }
      : null,
  });
}
