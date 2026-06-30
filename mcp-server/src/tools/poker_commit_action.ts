// poker_commit_action — MS-5 K2 commit-reveal MEV protection, commit half.
//
// Two-tx betting flow (when `BetSystem.commitRevealEnabled[tableId]` is true,
// flipped by the deploy/setup script per AP-06 #12 / 2026-05-22 audit):
//   1. poker_commit_action  → broadcasts commit hash; observers see only the
//                              hash, not action+amount → no last-mover MEV.
//   2. poker_reveal_action  → reveals action+amount+salt; on match, BetSystem
//                              runs `_doAct` exactly as if `act` had been called.
//
// This tool computes the commit hash off-chain (commitHashFor pre-image) and
// returns an unsignedTx for `BetSystem.commitAction(tableId, commitHash)`.
//
// **Caller MUST preserve `salt` and `handNumber` + `currentBet`** — they are
// required to reveal. The salt is CSPRNG-generated if not provided.
//
// The same args validation + state pre-flight as `poker_action` is reused
// (re-exported helpers from poker_action.ts), so brain LLMs see consistent
// error envelopes (E_CANNOT_CHECK, E_RAISE_TOO_SMALL, E_NOT_CURRENT_ACTOR, ...)
// regardless of whether commit-reveal is on or off.
//
// audit 2026-05-22 AP-06 #12 — yeni tool, commit-reveal'in MCP yüzeyi.

import { encodeFunctionData, keccak256, encodeAbiParameters } from "viem";
import { randomBytes } from "node:crypto";
import { readContractQuorum } from "../chains.js";
import { config } from "../config.js";
import {
  PokerBetAbi,
  PokerTableAbi,
  PokerActionEnum,
  type PokerActionLabel,
} from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";
import { validateAddress } from "../validate.js";

type TableState = { admin: `0x${string}`; currentActor: number; handNumber: bigint };
type SeatState = {
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
type RoundState = {
  handNumber: bigint;
  currentBet: bigint;
  minRaise: bigint;
  lastAggressor: number;
  actedBitmap: number;
  roundComplete: boolean;
};

export async function pokerCommitActionHandler(args: {
  player: string;
  tableId: string;
  action: string;
  amount?: string;
  salt?: string;
}) {
  // 1. Validate caller-supplied args.
  const player = validateAddress(args.player);
  if (!player) {
    return errorResult(
      err("E_INVALID_ADDRESS", "player must be a valid 0x-prefixed 20-byte address"),
    );
  }
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66 || !tableId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex"));
  }
  if (/^0x0{64}$/i.test(tableId)) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId cannot be zero"));
  }

  const rawLabel = args.action.toLowerCase();
  if (rawLabel === "allin") {
    return errorResult(
      err(
        "E_ACTION_REMOVED",
        "AllIn is implicit, not a distinct action — use 'call' or 'raise' with amount=stack target.",
      ),
    );
  }
  const label = rawLabel as PokerActionLabel;
  const enumValue = PokerActionEnum[label];
  if (enumValue === undefined) {
    return errorResult(
      err("E_INVALID_ACTION", `action must be one of: fold, check, call, raise (got '${args.action}')`),
    );
  }

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
  if ((label === "fold" || label === "check" || label === "call") && amount !== 0n) {
    return errorResult(
      err("E_AMOUNT_NOT_ALLOWED", `${label} requires amount=0 (BetSystem ignores it on-chain)`),
    );
  }
  if (label === "raise" && amount === 0n) {
    return errorResult(err("E_ZERO_AMOUNT", "raise requires amount > 0"));
  }

  // 2. Salt — accept caller's value or CSPRNG.
  let salt: `0x${string}`;
  if (args.salt) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(args.salt)) {
      return errorResult(err("E_INVALID_SALT", "salt must be 32-byte hex (0x + 64 chars)"));
    }
    salt = args.salt as `0x${string}`;
  } else {
    salt = ("0x" + randomBytes(32).toString("hex")) as `0x${string}`;
  }

  // 3. Read on-chain state — currentBet + handNumber are pre-image inputs.
  //    Claude 2026-05-25 P1 audit — readContractQuorum (not Retry alone).
  //    Tek-RPC retry can hit the SAME stale node N times under Arc LB
  //    eventual-consistency skew and produce a commitHash bound to a stale
  //    (handNumber, currentBet) tuple — the reveal then reverts with
  //    CommitRevealMismatch. Quorum reads (k-of-N) catch that disagreement
  //    BEFORE the commit hash is sealed.
  let table: TableState;
  let round: RoundState;
  let seat: SeatState;
  try {
    table = (await readContractQuorum({
      address: config.pokerTable as `0x${string}`,
      abi: PokerTableAbi,
      functionName: "getTable",
      args: [tableId],
    })) as TableState;
    if (!table.admin || /^0x0{40}$/i.test(table.admin)) {
      return errorResult(err("E_TABLE_NOT_FOUND", "tableId does not exist"));
    }
    if (table.currentActor === 255) {
      return errorResult(err("E_NO_CURRENT_ACTOR", "table has no current betting actor"));
    }
    seat = (await readContractQuorum({
      address: config.pokerTable as `0x${string}`,
      abi: PokerTableAbi,
      functionName: "getSeat",
      args: [tableId, table.currentActor],
    })) as SeatState;
    if (seat.player.toLowerCase() !== player.toLowerCase()) {
      return errorResult(
        err(
          "E_NOT_CURRENT_ACTOR",
          `player ${player} is not currentActor seat ${table.currentActor} (${seat.player})`,
        ),
      );
    }
    round = (await readContractQuorum({
      address: config.pokerBet as `0x${string}`,
      abi: PokerBetAbi,
      functionName: "getRound",
      args: [tableId],
    })) as RoundState;
  } catch (e) {
    return errorResult(
      err("E_STATE_READ_FAILED", `failed to read commit pre-image state: ${(e as Error).message}`),
    );
  }

  // 4. Pre-flight legality (mirror poker_action). Cheap fail-fast for the
  //    brain — the commit would land but the eventual reveal would revert with
  //    CannotCheck / RaiseTooSmall on-chain, wasting both txs' gas.
  if (label === "check") {
    const callAmount =
      round.currentBet > seat.currentBet ? round.currentBet - seat.currentBet : 0n;
    if (callAmount > 0n) {
      return errorResult(
        err(
          "E_CANNOT_CHECK",
          `Check illegal: round.currentBet=${round.currentBet}, seat.currentBet=${seat.currentBet}, callAmount=${callAmount}. Valid: call, raise (>= ${round.currentBet + round.minRaise}), fold.`,
        ),
      );
    }
  }
  if (label === "raise") {
    const minAcceptable = round.currentBet + round.minRaise;
    if (amount < minAcceptable) {
      return errorResult(
        err(
          "E_RAISE_TOO_SMALL",
          `raise amount ${amount} < currentBet(${round.currentBet}) + minRaise(${round.minRaise}) = ${minAcceptable}.`,
        ),
      );
    }
  }

  // 5. Compute commit hash off-chain (matches BetSystem.commitHashFor exactly:
  //    abi.encode(bytes32, uint64, address, uint256, uint8, uint256, bytes32)).
  const commitHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint64" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint8" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [tableId, table.handNumber, player, round.currentBet, enumValue, amount, salt],
    ),
  );

  // 6. Encode commitAction calldata.
  const data = encodeFunctionData({
    abi: PokerBetAbi,
    functionName: "commitAction",
    args: [tableId, commitHash],
  });

  return okResult({
    unsignedTx: {
      to: config.pokerBet,
      data,
      value: "0",
      chainId: config.arcChainId,
    },
    player,
    tableId,
    handNumber: table.handNumber.toString(),
    currentBet: round.currentBet.toString(),
    action: label,
    actionEnum: enumValue,
    amount: amount.toString(),
    salt,
    commitHash,
    note:
      "Broadcast commitAction. SAVE `salt` + `action` + `amount` for poker_reveal_action " +
      "(reveal must happen before commitDeadline = block.timestamp + 60s). The pre-image " +
      "is bound to (handNumber, currentBet) at commit time — if the round changes before " +
      "you reveal, the reveal will fail with CommitRevealMismatch.",
  });
}
