import { encodeFunctionData } from "viem";
import { readContractWithRetry } from "../chains.js";
import { config } from "../config.js";
import { PokerBetAbi, PokerTableAbi, PokerActionEnum, type PokerActionLabel } from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";
import { validateAddress } from "../validate.js";

type RoundState = {
  handNumber: bigint;
  currentBet: bigint;
  minRaise: bigint;
  lastAggressor: number;
  actedBitmap: number;
  roundComplete: boolean;
};

type TableState = {
  admin: `0x${string}`;
  currentActor: number;
};

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

type RawArgs = {
  player: string;
  tableId: string;
  action: string;        // fold | check | call | raise (allin implicit via partial-call)
  amount?: string;       // chips amount for raise/call (default "0")
};

type ValidatedArgs = {
  player: `0x${string}`;
  tableId: `0x${string}`;
  label: PokerActionLabel;
  enumValue: number;
  amount: bigint;
};

type StateRead = {
  seatCurrentBet: bigint;
  roundCurrentBet: bigint;
  roundMinRaise: bigint;
  roundReadOk: boolean;
};

type ToolErr = ReturnType<typeof errorResult>;

export async function pokerActionHandler(args: RawArgs) {
  const validated = _validateArgs(args);
  if ("error" in validated) return validated.error;

  const state = await _readState(validated.valid);
  if ("error" in state) return state.error;

  const legality = _checkLegality(validated.valid, state.state);
  if (legality) return legality;

  return _buildResult(validated.valid);
}

// ---------------------------------------------------------------------------
// Helpers (module-private). Handler stays short; each step is independently
// testable / replaceable.
// ---------------------------------------------------------------------------

// audit 2026-05-22 MC-13 — `_validateArgs` ve `_checkLegality` export
// edildi; tool handler tüm RPC chain'i bağladığı için unit test'te taklit
// güç. Helper'lar pure (RPC yok) → fixture state ile unit-testable.
export function _validateArgs(args: RawArgs): { valid: ValidatedArgs } | { error: ToolErr } {
  // audit 2026-05-22 MC-09 — runtime adres doğrulama.
  const player = validateAddress(args.player);
  if (!player) {
    return { error: errorResult(err("E_INVALID_ADDRESS", "player must be a valid 0x-prefixed 20-byte address")) };
  }
  const tableId = args.tableId as `0x${string}`;

  if (player === "0x0000000000000000000000000000000000000000") {
    return { error: errorResult(err("E_INVALID_PLAYER", "player address cannot be zero")) };
  }
  if (!tableId || tableId.length !== 66 || !tableId.startsWith("0x")) {
    return { error: errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex")) };
  }
  // 2026-05-14 Codex handoff — `0x0...0` bir bayt-uzunluğu olarak geçerli ama
  // anlam olarak "table yok" demek. Brain bunu üretebiliyor; on-chain'e gitse
  // CallerNotAuthorized / TableNotFound revert'ine yol açıyor ve gas yakıyor.
  if (/^0x0{64}$/i.test(tableId)) {
    return { error: errorResult(err("E_INVALID_TABLE_ID", "tableId cannot be zero")) };
  }

  const rawLabel = args.action.toLowerCase();
  // 2026-05-10 — `allin` removed (BetSystem.Action enum is {Fold,Check,Call,Raise};
  // all-in is implicit via partial-call). Reject with a helpful redirect.
  if (rawLabel === "allin") {
    return {
      error: errorResult(
        err(
          "E_ACTION_REMOVED",
          "AllIn is implicit, not a distinct action — use 'call' (BetSystem auto-handles partial-call → seat.allIn=true) or 'raise' with amount=your stack target.",
        ),
      ),
    };
  }
  const label = rawLabel as PokerActionLabel;
  const enumValue = PokerActionEnum[label];
  if (enumValue === undefined) {
    return {
      error: errorResult(
        err("E_INVALID_ACTION", `action must be one of: fold, check, call, raise (got '${args.action}')`),
      ),
    };
  }

  // audit 2026-05-22 MC-10 — BigInt parse try/catch.
  let amount: bigint;
  try {
    amount = BigInt(args.amount ?? "0");
  } catch {
    return { error: errorResult(err("E_INVALID_AMOUNT", "amount must be a numeric string")) };
  }
  if (amount < 0n) {
    return { error: errorResult(err("E_NEGATIVE_AMOUNT", "amount cannot be negative")) };
  }

  // BetSystem.act semantics (BetSystem.sol):
  //   fold/check/call: amount IGNORED on-chain. We require 0 in the unsigned
  //     tx so a misleading non-zero is never broadcast. Call need is computed
  //     by the contract from RoundState.currentBet - seat.currentBet.
  //     Partial-call (player stack < call need) automatically sets seat.allIn.
  //   raise: amount is the new ABSOLUTE round-level high bet target (the new
  //     RoundState.currentBet). Contract derives `paid = amount - seat.currentBet`
  //     and enforces `amount - r.currentBet >= r.minRaise`.
  if ((label === "fold" || label === "check" || label === "call") && amount !== 0n) {
    return {
      error: errorResult(err("E_AMOUNT_NOT_ALLOWED", `${label} requires amount=0 (BetSystem ignores it on-chain)`)),
    };
  }
  if (label === "raise" && amount === 0n) {
    return {
      error: errorResult(err("E_ZERO_AMOUNT", "raise requires amount > 0 (absolute new high-bet target)")),
    };
  }

  return { valid: { player, tableId, label, enumValue, amount } };
}

// 2026-05-14 Codex handoff + 2026-05-17 brain-validation extension —
// Pre-flight state validation:
//   1) table mevcut mu? (admin=0 ise yok)
//   2) currentActor sentinel (255) → bahis turu yok, hiçbir action geçerli değil
//   3) player gerçekten currentActor seat'inde mi? (NotYourTurn'ü on-chain'e yansıtmadan döndür)
//   4) Check yasal mı? (callAmount=round.currentBet - seat.currentBet > 0 ise Check → CannotCheck revert)
//   5) Raise min-raise threshold (mevcut Codex pattern, getRound read'i bu blokta birleştirildi)
// Read failure E_STATE_READ_FAILED — chains.ts readContractWithRetry retry'i
// zaten yutuyor, transient flapping fatal'a dönüşmez.
// audit 2026-05-22 MC-11 — explicit readContractWithRetry kullanımı (caller
// try/catch ile sarmalı; arcClient monkey-patch'i aynı şeyi yapıyor olsa da
// niyet okunaklı olsun).
async function _readState(args: ValidatedArgs): Promise<{ state: StateRead } | { error: ToolErr }> {
  let seatCurrentBet = 0n;
  let roundCurrentBet = 0n;
  let roundMinRaise = 0n;
  let roundReadOk = false;
  try {
    // Claude 2026-05-25 P1 audit — commit-reveal=true fail-fast. Tool doc
    // promises "commitRevealEnabled=true REDDEDILIR" but the handler never
    // checked it. Mainnet tables ship with commit-reveal ON
    // (start-all.sh + deploy scripts call setCommitReveal(true)); without
    // this gate the legacy `act` tx is built, broadcast, and reverted by
    // CommitRevealRequired — gas burned, telemetry confused. Surface early.
    const crEnabled = (await readContractWithRetry({
      address: config.pokerBet as `0x${string}`,
      abi: PokerBetAbi,
      functionName: "commitRevealEnabled",
      args: [args.tableId],
    })) as boolean;
    if (crEnabled) {
      return {
        error: errorResult(
          err(
            "E_COMMIT_REVEAL_REQUIRED",
            "Table has commit-reveal enabled — poker_action (single-tx) reverts with CommitRevealRequired. " +
              "Use poker_commit_action (commit phase) then poker_reveal_action (reveal phase).",
          ),
        ),
      };
    }
    const table = (await readContractWithRetry({
      address: config.pokerTable as `0x${string}`,
      abi: PokerTableAbi,
      functionName: "getTable",
      args: [args.tableId],
    })) as TableState;
    if (!table.admin || /^0x0{40}$/i.test(table.admin)) {
      return { error: errorResult(err("E_TABLE_NOT_FOUND", "tableId does not exist")) };
    }
    if (table.currentActor === 255) {
      return { error: errorResult(err("E_NO_CURRENT_ACTOR", "table has no current betting actor")) };
    }

    const seat = (await readContractWithRetry({
      address: config.pokerTable as `0x${string}`,
      abi: PokerTableAbi,
      functionName: "getSeat",
      args: [args.tableId, table.currentActor],
    })) as SeatState;
    if (seat.player.toLowerCase() !== args.player.toLowerCase()) {
      return {
        error: errorResult(
          err(
            "E_NOT_CURRENT_ACTOR",
            `player ${args.player} is not currentActor seat ${table.currentActor} (${seat.player})`,
          ),
        ),
      };
    }
    seatCurrentBet = seat.currentBet;

    try {
      const round = (await readContractWithRetry({
        address: config.pokerBet as `0x${string}`,
        abi: PokerBetAbi,
        functionName: "getRound",
        args: [args.tableId],
      })) as RoundState;
      roundCurrentBet = round.currentBet;
      roundMinRaise = round.minRaise;
      roundReadOk = true;
    } catch {
      // getRound transient blip — surface as E_STATE_READ_FAILED only if
      // the action needs round state (check/raise). Fold/call gracefully
      // degrade to on-chain enforcement.
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return {
      error: errorResult(err("E_STATE_READ_FAILED", `failed to validate poker_action state: ${msg.slice(0, 240)}`)),
    };
  }

  return { state: { seatCurrentBet, roundCurrentBet, roundMinRaise, roundReadOk } };
}

export function _checkLegality(args: ValidatedArgs, state: StateRead): ToolErr | null {
  // 2026-05-17 — Check legality. BetSystem.act enforces
  // `_callAmount(r,s) == 0` for Check (CannotCheck revert otherwise).
  // _callAmount = max(0, r.currentBet - s.currentBet). Brain LLMs frequently
  // emit Check at preflop UTG (where BB=100, seat.currentBet=0 → callAmount=100)
  // because their state-summary parser overlooks the round high bet. Pre-check
  // here returns a helpful error so the brain can retry with call/fold/raise
  // without burning gas on a CannotCheck revert.
  if (args.label === "check") {
    if (!state.roundReadOk) {
      return errorResult(err("E_STATE_READ_FAILED", "could not read round state to validate check legality"));
    }
    const callAmount =
      state.roundCurrentBet > state.seatCurrentBet ? state.roundCurrentBet - state.seatCurrentBet : 0n;
    if (callAmount > 0n) {
      return errorResult(
        err(
          "E_CANNOT_CHECK",
          `Check illegal: round.currentBet=${state.roundCurrentBet}, seat.currentBet=${state.seatCurrentBet}, callAmount=${callAmount}. Valid actions: call (matches ${callAmount}), raise (>= ${state.roundCurrentBet + state.roundMinRaise}), fold.`,
        ),
      );
    }
  }

  // 2026-05-10 — Raise pre-validation. BetSystem.sol enforces
  // `amount - r.currentBet >= r.minRaise` (RaiseTooSmall revert). Brain LLMs
  // frequently emit raise(currentBet) or raise(currentBet + small) because the
  // absolute vs. delta semantics is subtle. Pre-check here surfaces a helpful
  // error so the brain can retry with a valid amount instead of paying gas to
  // see RaiseTooSmall on-chain.
  if (args.label === "raise" && state.roundReadOk) {
    const minAcceptable = state.roundCurrentBet + state.roundMinRaise;
    if (args.amount < minAcceptable) {
      return errorResult(
        err(
          "E_RAISE_TOO_SMALL",
          `raise amount ${args.amount} < currentBet(${state.roundCurrentBet}) + minRaise(${state.roundMinRaise}) = ${minAcceptable}. Use amount >= ${minAcceptable}, or pick 'call' to match currentBet, or 'fold'.`,
        ),
      );
    }
  }

  return null;
}

function _buildResult(args: ValidatedArgs) {
  const data = encodeFunctionData({
    abi: PokerBetAbi,
    functionName: "act",
    args: [args.tableId, args.enumValue, args.amount],
  });

  return okResult({
    unsignedTx: {
      to: config.pokerBet,
      data,
      value: "0",
      chainId: config.arcChainId,
    },
    player: args.player,
    tableId: args.tableId,
    action: args.label,
    actionEnum: args.enumValue,
    amount: args.amount.toString(),
    note: "Player signs. BetSystem validates the action against the current round + seat. For raise, amount is the new absolute round-level high bet target.",
  });
}
