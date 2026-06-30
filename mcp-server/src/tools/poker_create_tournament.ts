import { encodeFunctionData, keccak256, stringToHex, parseUnits } from "viem";
import { config } from "../config.js";
import { PokerOrchestratorAbi } from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";
import { validateAddress } from "../validate.js";

const DEFAULT_PAYOUT_BPS = [5_000, 3_000, 2_000] as const; // 50/30/20
const DEFAULT_REP_DELTA  = [30,    10,    0]    as const;

export async function pokerCreateTournamentHandler(args: {
  admin: string;
  name: string;
  entryFeeUsdc?: string;
  minPlayers?: number;
  maxPlayers?: number;
  payoutBps?: number[];
  reputationDelta?: number[];
  registrationWindowSec?: number;
}) {
  // audit 2026-05-22 MC-09 — runtime adres doğrulama.
  const admin = validateAddress(args.admin);
  if (!admin) {
    return errorResult(err("E_INVALID_ADDRESS", "admin must be a valid 0x-prefixed 20-byte address"));
  }
  if (admin === "0x0000000000000000000000000000000000000000") {
    return errorResult(err("E_INVALID_ADMIN", "admin address cannot be zero"));
  }
  if (!args.name || args.name.length === 0) {
    return errorResult(err("E_EMPTY_NAME", "tournament name cannot be empty"));
  }

  // audit 2026-05-22 MC-10 — parseUnits try/catch (geçersiz numeric MCP crash).
  let entryFee: bigint;
  try {
    entryFee = parseUnits(args.entryFeeUsdc ?? "1.00", 6); // USDC has 6 decimals
  } catch (e) {
    return errorResult(err("E_INVALID_ENTRY_FEE", `entryFeeUsdc must be a numeric string: ${(e as Error).message}`));
  }
  const minPlayers = args.minPlayers ?? 2;
  const maxPlayers = args.maxPlayers ?? 8;

  if (minPlayers < 2 || maxPlayers > 9 || maxPlayers < minPlayers) {
    return errorResult(err("E_INVALID_PLAYERS", "minPlayers in [2,9], maxPlayers in [minPlayers,9]"));
  }

  const payoutBps = args.payoutBps ?? Array.from(DEFAULT_PAYOUT_BPS);
  const repDelta  = args.reputationDelta ?? Array.from(DEFAULT_REP_DELTA);
  if (payoutBps.length !== repDelta.length) {
    return errorResult(err("E_PAYOUT_MISMATCH", "payoutBps.length must equal reputationDelta.length"));
  }
  const sum = payoutBps.reduce((a, b) => a + b, 0);
  if (sum !== 10_000) {
    return errorResult(err("E_PAYOUT_SUM", `payoutBps must sum to 10000 (got ${sum})`));
  }
  // Contract: payoutBps.length must be > 0 and <= maxPlayers (else InvalidPayout).
  if (payoutBps.length > maxPlayers) {
    return errorResult(err("E_PAYOUT_TOO_LONG", `payoutBps.length (${payoutBps.length}) must be <= maxPlayers (${maxPlayers})`));
  }
  // registrationDeadline (uint64) — REQUIRED 6th createTournament arg. Contract
  // requires block.timestamp < deadline <= block.timestamp + MAX_REGISTRATION_WINDOW
  // (~7 days). Default a 24h registration window; clamp to [60s, 7d].
  const windowSec = Math.min(Math.max(args.registrationWindowSec ?? 86_400, 60), 604_800);
  const registrationDeadline = BigInt(Math.floor(Date.now() / 1000) + windowSec);

  // Deterministic tournamentId derived from name keccak256.
  const tournamentId = keccak256(stringToHex(args.name));

  const data = encodeFunctionData({
    abi: PokerOrchestratorAbi,
    functionName: "createTournament",
    args: [
      tournamentId,
      config.usdc,
      entryFee,
      minPlayers,
      maxPlayers,
      registrationDeadline,
      payoutBps,
      repDelta.map((n) => BigInt(n)),
    ],
  });

  return okResult({
    unsignedTx: {
      to: config.pokerOrchestrator,
      data,
      value: "0",
      chainId: config.arcChainId,
    },
    admin,
    tournamentId,
    name: args.name,
    entryFeeUsdc: args.entryFeeUsdc ?? "1.00",
    entryFeeRaw: entryFee.toString(),
    minPlayers,
    maxPlayers,
    registrationDeadline: registrationDeadline.toString(),
    payoutBps,
    reputationDelta: repDelta,
    note: "Admin signs. After receipt, tournament is in Registering phase.",
  });
}
