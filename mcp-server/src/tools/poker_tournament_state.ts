import { readContractWithRetry } from "../chains.js";
import { PokerOrchestratorAbi } from "../poker-abis.js";
import { resolveActiveOrchestrator } from "../resolve-orchestrator.js";
import { okResult, errorResult, err } from "../errors.js";

const PHASE_LABELS = ["Draft", "Registering", "Running", "Finalized", "Cancelled"] as const;

export async function pokerTournamentStateHandler(args: {
  tournamentId: string;
}) {
  const tournamentId = args.tournamentId as `0x${string}`;
  if (!tournamentId || tournamentId.length !== 66) {
    return errorResult(err("E_INVALID_TOURNAMENT_ID", "tournamentId must be 32-byte hex"));
  }

  // readContractWithRetry + top-level try/catch so an RPC blip is reported, not
  // a crash. tournamentOf is the 8-output form (registrationDeadline 8th); the
  // bound tableId/tableSystem come from the public mapping getters, which lets a
  // caller learn the table without an out-of-band hand-off.
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  const ZERO_BYTES32 =
    "0x0000000000000000000000000000000000000000000000000000000000000000";
  let tournRaw: readonly [
    `0x${string}`,
    `0x${string}`,
    bigint,
    number,
    number,
    number,
    number,
    bigint,
  ];
  let roster: readonly bigint[];
  let tableId: `0x${string}`;
  let tableSystem: `0x${string}`;
  // Resolve the canonical orchestrator (drift-proof) — same resolution discovery
  // and register use, so all three agree on the address even if env is stale.
  const resolved = await resolveActiveOrchestrator();
  const orchestrator = resolved.orchestrator;
  try {
    [tournRaw, roster, tableId, tableSystem] = await Promise.all([
      readContractWithRetry({
        address: orchestrator,
        abi: PokerOrchestratorAbi,
        functionName: "tournamentOf",
        args: [tournamentId],
      }) as Promise<readonly [
        `0x${string}`,
        `0x${string}`,
        bigint,
        number,
        number,
        number,
        number,
        bigint,
      ]>,
      readContractWithRetry({
        address: orchestrator,
        abi: PokerOrchestratorAbi,
        functionName: "rosterOf",
        args: [tournamentId],
      }) as Promise<readonly bigint[]>,
      readContractWithRetry({
        address: orchestrator,
        abi: PokerOrchestratorAbi,
        functionName: "tableIdOf",
        args: [tournamentId],
      }) as Promise<`0x${string}`>,
      readContractWithRetry({
        address: orchestrator,
        abi: PokerOrchestratorAbi,
        functionName: "tableSystemOf",
        args: [tournamentId],
      }) as Promise<`0x${string}`>,
    ]);
  } catch (e) {
    return errorResult(err("E_READ_FAILED", `tournament state read failed: ${(e as Error).message}`));
  }

  const [admin, token, entryFee, minPlayers, maxPlayers, registered, phase, regDeadline] = tournRaw;
  if (admin === ZERO_ADDR) {
    return errorResult(err("E_TOURNAMENT_NOT_FOUND", "tournamentId not found"));
  }

  const registrationDeadline = Number(regDeadline);
  const seatsOpen = maxPlayers - registered;
  const deadlinePassed = Math.floor(Date.now() / 1000) >= registrationDeadline;
  const boundTable = tableId !== ZERO_BYTES32 && tableSystem !== ZERO_ADDR;
  // joinable mirrors the contract's register()/registerWithAuthorization()
  // preconditions: phase==Registering(1), a free seat, and a bound table. The
  // contract does NOT gate registration on registrationDeadline (that only
  // triggers permissionless cancel of an underfilled tournament), so the deadline
  // is advisory only — a past-deadline game is still registerable but at risk of
  // being cancelled before it fills.
  const joinable = phase === 1 && registered < maxPlayers && boundTable;

  return okResult({
    tournamentId,
    admin,
    token,
    entryFeeRaw: entryFee.toString(),
    minPlayers,
    maxPlayers,
    registered,
    seatsOpen,
    phase: PHASE_LABELS[phase] ?? `Unknown(${phase})`,
    phaseEnum: phase,
    registrationDeadline,
    deadlinePassed,
    tableId: boundTable ? tableId : null,
    tableSystem: boundTable ? tableSystem : null,
    joinable,
    orchestrator,
    orchestratorSource: resolved.source,
    roster: roster.map((id) => id.toString()),
  });
}
