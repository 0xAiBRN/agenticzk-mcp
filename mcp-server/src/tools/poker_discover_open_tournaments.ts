import { parseAbiItem, type Address, type Hex } from "viem";
import { arcClient, readContractWithRetry } from "../chains.js";
import { config } from "../config.js";
import { PokerOrchestratorAbi } from "../poker-abis.js";
import { resolveActiveOrchestrator } from "../resolve-orchestrator.js";
import { okResult, errorResult, err } from "../errors.js";

// poker_discover_open_tournaments — read-only, signs NOTHING.
//
// Lets an agent find open tournaments on-chain with zero central lobby/server
// (HC#2): it asks the ProtocolRegistry which orchestrator is canonical
// (drift-proof, shared with register/state), scans that orchestrator's
// TournamentCreated logs over a recent window, then reads each tournament's
// joinability from public getters. The returned rows carry `joinable` +
// `onCanonicalToken` + `onCanonicalVersion` + `secondsLeft`/`deadlinePassed` so
// the agent/skill layer can apply its own deterministic safety pre-filter
// (affordability, freshness) before an LLM picks a stake. The tool itself never
// moves money and never decides — discovery only.

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;
const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

// TournamentCreated(bytes32 indexed tournamentId, address indexed creator,
// address indexed token, uint256 entryFee, uint8 minPlayers, uint8 maxPlayers,
// uint64 registrationDeadline) — matches TournamentOrchestrator.sol exactly.
const TOURNAMENT_CREATED_EVENT = parseAbiItem(
  "event TournamentCreated(bytes32 indexed tournamentId, address indexed creator, address indexed token, uint256 entryFee, uint8 minPlayers, uint8 maxPlayers, uint64 registrationDeadline)",
);

// Recent window when the deploy block is unknown. A tournament's
// registrationDeadline is capped at 7 days, and a registered-but-not-started game
// cannot be older than that, so a 7-day window is sufficient. Arc runs ~0.5s per
// block (see agent-runner arc-tx.ts), so 7 days ~= 7*86400/0.5 ~= 1.21M blocks;
// 1.3M gives headroom. (For exact, set POKER_ORCHESTRATOR_DEPLOY_BLOCK.)
const DEFAULT_LOOKBACK_BLOCKS = 1_300_000n;
// getLogs block-range chunk; halved on RPC failure (Arc caps eth_getLogs ranges).
const INITIAL_CHUNK = 50_000n;
const MIN_CHUNK = 1_000n;
const MAX_RESULTS_CAP = 200;

type TournamentOfResult = readonly [
  Address, // creator
  Address, // token
  bigint, // entryFee
  number, // minPlayers
  number, // maxPlayers
  number, // registered
  number, // phase
  bigint, // registrationDeadline (uint64)
];

const READ_FAILED = Symbol("read-failed");

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 150 * 2 ** i));
    }
  }
  throw lastErr;
}

/** Scan TournamentCreated logs in halving chunks; returns unique tournamentIds. */
async function scanTournamentIds(
  orchestrator: Address,
  fromBlock: bigint,
  toBlock: bigint,
  warnings: string[],
): Promise<Hex[]> {
  const ids = new Set<Hex>();
  let cursor = fromBlock;
  let chunk = INITIAL_CHUNK;
  let safety = 0;
  while (cursor <= toBlock) {
    if (safety++ > 10_000) {
      warnings.push("scan aborted: too many getLogs chunks (range too wide).");
      break;
    }
    const end = cursor + chunk - 1n > toBlock ? toBlock : cursor + chunk - 1n;
    try {
      const logs = await arcClient.getLogs({
        address: orchestrator,
        event: TOURNAMENT_CREATED_EVENT,
        fromBlock: cursor,
        toBlock: end,
      });
      for (const log of logs) {
        const tid = log.args?.tournamentId;
        if (tid) ids.add(tid as Hex);
      }
      cursor = end + 1n;
      // gently grow the window back toward the initial chunk after a success
      if (chunk < INITIAL_CHUNK) chunk = chunk * 2n > INITIAL_CHUNK ? INITIAL_CHUNK : chunk * 2n;
    } catch (e) {
      if (chunk > MIN_CHUNK) {
        chunk = chunk / 2n;
      } else {
        warnings.push(
          `getLogs failed at blocks ${cursor}-${end} (skipped): ${(e as Error).message.slice(0, 100)}`,
        );
        cursor = end + 1n;
      }
    }
  }
  return [...ids];
}

export async function pokerDiscoverOpenTournamentsHandler(args: {
  token?: string;
  maxEntryFee?: string;
  minSeatsOpen?: number;
  lookbackBlocks?: number;
  onlyCanonicalVersion?: boolean;
  limit?: number;
}) {
  // Validate coercible inputs up front so a bad value returns a clean MCP error
  // instead of throwing inside BigInt().
  let maxEntryFee: bigint | null = null;
  if (args.maxEntryFee != null) {
    try {
      maxEntryFee = BigInt(args.maxEntryFee);
      if (maxEntryFee < 0n) throw new Error("negative");
    } catch {
      return errorResult(err("E_INVALID_INPUT", "maxEntryFee must be a non-negative integer string (6-decimal USDC units)"));
    }
  }
  if (args.lookbackBlocks != null && (!Number.isInteger(args.lookbackBlocks) || args.lookbackBlocks < 0)) {
    return errorResult(err("E_INVALID_INPUT", "lookbackBlocks must be a non-negative integer"));
  }

  // 1. Resolve the canonical orchestrator (drift-proof) — the SAME resolution
  //    register/state use, so discovery can't surface a tournament they then look
  //    for on a different orchestrator.
  const resolved = await resolveActiveOrchestrator();
  const orchestrator = resolved.orchestrator;
  const canonicalTableSystem = resolved.canonicalTableSystem;
  const registrySemver = resolved.semver;
  const warnings: string[] = [...resolved.warnings];

  // 2. Determine the scan range + chain "now" (block.timestamp, the clock the
  //    contract's deadline check actually uses).
  let latestBlock: bigint;
  let asOfUnix: number;
  try {
    latestBlock = await withRetry(() => arcClient.getBlockNumber());
    const block = await withRetry(() => arcClient.getBlock({ blockNumber: latestBlock }));
    asOfUnix = Number(block.timestamp);
  } catch (e) {
    return errorResult(
      err("E_READ_FAILED", `chain head read failed: ${(e as Error).message}`),
    );
  }

  const lookback =
    args.lookbackBlocks != null && args.lookbackBlocks > 0
      ? BigInt(args.lookbackBlocks)
      : DEFAULT_LOOKBACK_BLOCKS;
  let fromBlock: bigint;
  if (config.pokerOrchestratorDeployBlock != null) {
    fromBlock = config.pokerOrchestratorDeployBlock;
  } else {
    fromBlock = latestBlock > lookback ? latestBlock - lookback : 0n;
    warnings.push(
      "recent window only, not all-history — games created before the scan window are not listed (a still-open game cannot be older than its 7-day max deadline).",
    );
  }

  // 3. Scan TournamentCreated logs → unique tournamentIds.
  const ids = await scanTournamentIds(orchestrator, fromBlock, latestBlock, warnings);

  // 4. Read each tournament's joinability from public getters (no multicall3 on
  //    Arc — parallel single reads, the established MCP pattern). A read failure
  //    yields READ_FAILED (counted), distinct from a pruned/not-found tournament.
  const usdc = config.usdc.toLowerCase();
  const rows = await Promise.all(
    ids.map(async (tid) => {
      try {
        const [t, tableId, tableSystem] = await Promise.all([
          readContractWithRetry({
            address: orchestrator,
            abi: PokerOrchestratorAbi,
            functionName: "tournamentOf",
            args: [tid],
          }) as Promise<TournamentOfResult>,
          readContractWithRetry({
            address: orchestrator,
            abi: PokerOrchestratorAbi,
            functionName: "tableIdOf",
            args: [tid],
          }) as Promise<Hex>,
          readContractWithRetry({
            address: orchestrator,
            abi: PokerOrchestratorAbi,
            functionName: "tableSystemOf",
            args: [tid],
          }) as Promise<Address>,
        ]);

        const [creator, token, entryFee, minPlayers, maxPlayers, registered, phase, regDeadline] = t;
        if (creator === ZERO_ADDR) return null; // not found / pruned

        const deadline = Number(regDeadline);
        const seatsOpen = maxPlayers - registered;
        const secondsLeft = deadline - asOfUnix;
        const deadlinePassed = asOfUnix >= deadline;
        const boundTable = tableId !== ZERO_BYTES32 && tableSystem !== ZERO_ADDR;
        const onCanonicalToken = token.toLowerCase() === usdc;
        // null when the registry was unavailable → caller must not treat as verified
        const onCanonicalVersion =
          canonicalTableSystem == null
            ? null
            : tableSystem.toLowerCase() === canonicalTableSystem.toLowerCase();
        // register()/registerWithAuthorization() require ONLY phase==Registering(1),
        // a free seat, and a bound table. The contract does NOT gate registration on
        // registrationDeadline (that only triggers permissionless cancel of an
        // underfilled tournament), so `joinable` excludes the deadline. secondsLeft /
        // deadlinePassed are advisory: a past-deadline game is still registerable but
        // risks being cancelled before it fills.
        // Phase enum { Draft=0, Registering=1, Running=2, Finalized=3, Cancelled=4 }.
        const joinable = phase === 1 && registered < maxPlayers && boundTable;

        return {
          tournamentId: tid,
          tableId,
          tableSystem,
          token,
          entryFee: entryFee.toString(),
          minPlayers,
          maxPlayers,
          registered,
          seatsOpen,
          registrationDeadline: deadline,
          secondsLeft,
          deadlinePassed,
          phase,
          joinable,
          onCanonicalToken,
          onCanonicalVersion,
        };
      } catch {
        return READ_FAILED;
      }
    }),
  );

  const skippedCount = rows.filter((r) => r === READ_FAILED).length;
  if (skippedCount > 0) {
    warnings.push(`${skippedCount} tournament(s) skipped — per-tournament read failed (RPC); re-run to retry.`);
  }

  // 5. Structural filters (NOT the security boundary — the agent/skill layer adds
  //    affordability + freshness pre-filter; this tool only exposes the data).
  type Row = Exclude<(typeof rows)[number], typeof READ_FAILED | null>;
  let tournaments = rows.filter((r): r is Row => r !== null && r !== READ_FAILED);

  if (args.token) {
    const want = args.token.toLowerCase();
    tournaments = tournaments.filter((r) => r.token.toLowerCase() === want);
  } else {
    // default: only the configured USDC token (honeypot-token gate)
    tournaments = tournaments.filter((r) => r.onCanonicalToken);
  }
  if (maxEntryFee != null) {
    tournaments = tournaments.filter((r) => BigInt(r.entryFee) <= maxEntryFee!);
  }
  const minSeats = args.minSeatsOpen ?? 1;
  tournaments = tournaments.filter((r) => r.seatsOpen >= minSeats);
  if (args.onlyCanonicalVersion !== false && canonicalTableSystem != null) {
    tournaments = tournaments.filter((r) => r.onCanonicalVersion === true);
  }

  // cheapest-affordable first, then most time left — friendly to the LLM picker
  tournaments.sort((a, b) => {
    const fee = BigInt(a.entryFee) - BigInt(b.entryFee);
    if (fee !== 0n) return fee < 0n ? -1 : 1;
    return b.secondsLeft - a.secondsLeft;
  });

  const limit = Math.min(args.limit ?? 50, MAX_RESULTS_CAP);
  if (tournaments.length > limit) {
    warnings.push(`result truncated to ${limit} of ${tournaments.length} matching tournaments.`);
    tournaments = tournaments.slice(0, limit);
  }

  return okResult({
    asOfUnix,
    scannedFromBlock: Number(fromBlock),
    scannedToBlock: Number(latestBlock),
    activeOrchestrator: orchestrator,
    orchestratorSource: resolved.source,
    registrySemver,
    skippedCount,
    joinableCount: tournaments.filter((r) => r.joinable).length,
    tournaments,
    warnings,
  });
}
