// ShuffleDeckEmitted event reader — ZK Shuffle Gas milestone (2026-05-21).
//
// The gas-optimised shuffle keeps intermediate decks (deck_1..deck_{N-1}) OFF
// chain storage — storing 52 cards would cost ~208 SSTOREs per round, the very
// gas the milestone removes. Each first/mid round instead emits its output
// deck in a `ShuffleDeckEmitted` event as the data-availability payload. The
// next shuffler (round r >= 1) reads its input deck — deck_r, produced by
// round r-1 — from that event rather than from DealSystem storage (which still
// holds deck_0 until submitShuffleLast writes deck_N).
//
// Scoping: ShuffleDeckEmitted's `tableId` and `producingRound` are both indexed
// (topic-filterable). `producingRound` repeats across hands (round 1 of hand 5
// and round 1 of hand 6 both emit producingRound=1), so the current hand's
// emission is identified as the one with the highest block number — a later
// hand cannot have reached this round yet while we are mid-shuffle. We scan
// newest-first in bounded chunks and stop at the first chunk with a match.

import { decodeEventLog, type Log } from "viem";
import { arcClient } from "../chains.js";
import { config } from "../config.js";
import { PokerDealAbi } from "../poker-abis.js";
import type { Point } from "./shuffle-input.js";

const DECK_SIZE = 52;

// Chunked backward scan tunables. The previous round's tx is typically seconds
// old, so the first (newest) chunk almost always contains it; the lookback is
// only a safety ceiling. Both env-overridable for RPCs with strict getLogs
// block-range limits.
const EVENT_CHUNK_BLOCKS = BigInt(process.env.ARC_MCP_EVENT_CHUNK_BLOCKS ?? 5_000);
const EVENT_LOOKBACK_BLOCKS = BigInt(process.env.ARC_MCP_EVENT_LOOKBACK_BLOCKS ?? 100_000);
const EVENT_RETRY_ATTEMPTS = Number(process.env.ARC_MCP_EVENT_RETRY_ATTEMPTS ?? 6);
const EVENT_RETRY_BASE_MS = Number(process.env.ARC_MCP_EVENT_RETRY_BASE_MS ?? 500);
const EVENT_RETRY_MAX_MS = Number(process.env.ARC_MCP_EVENT_RETRY_MAX_MS ?? 8_000);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryable(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  if (/daily request limit reached/i.test(m)) return false;
  return /timeout|temporarily unavailable|rate limit|too many requests|429|500|502|503|504|ECONNRESET|ETIMEDOUT|fetch failed|network error|context cancel|context deadline/i.test(
    m,
  );
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= EVENT_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || attempt >= EVENT_RETRY_ATTEMPTS) throw e;
      await sleep(Math.min(EVENT_RETRY_MAX_MS, EVENT_RETRY_BASE_MS * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

const SHUFFLE_DECK_EMITTED_ABI = PokerDealAbi.filter(
  (x) => x.type === "event" && x.name === "ShuffleDeckEmitted",
);

export type EmittedDeck = {
  c1: Point[];
  c2: Point[];
  /** Block the deck was emitted in — useful for read-after-write barriers. */
  blockNumber: bigint;
  /** keccak256(abi.encode(c1,c2)) topic-free identity is computed by callers. */
  producingRound: number;
};

function toDeck(log: Log): { c1: Point[]; c2: Point[] } {
  const decoded = decodeEventLog({
    abi: SHUFFLE_DECK_EMITTED_ABI,
    data: log.data,
    topics: log.topics,
  });
  const args = decoded.args as unknown as {
    c1: readonly (readonly [bigint, bigint])[];
    c2: readonly (readonly [bigint, bigint])[];
  };
  if (args.c1.length !== DECK_SIZE || args.c2.length !== DECK_SIZE) {
    throw new Error(
      `ShuffleDeckEmitted carried ${args.c1.length}/${args.c2.length} cards; expected ${DECK_SIZE}`,
    );
  }
  return {
    c1: args.c1.map((p) => [p[0], p[1]] as Point),
    c2: args.c2.map((p) => [p[0], p[1]] as Point),
  };
}

/**
 * Read the encrypted deck a given round emitted as its DA payload — i.e. the
 * INPUT deck for round `producingRound + 1`. Returns the most recent emission
 * (the current hand's). Throws if no emission is found within the lookback.
 */
export async function readEmittedDeck(
  tableId: `0x${string}`,
  producingRound: number,
): Promise<EmittedDeck> {
  const head = await withRetry(() => arcClient.getBlockNumber());
  const floor = head > EVENT_LOOKBACK_BLOCKS ? head - EVENT_LOOKBACK_BLOCKS : 0n;

  let hi = head;
  while (hi >= floor) {
    const lo = hi >= floor + EVENT_CHUNK_BLOCKS ? hi - EVENT_CHUNK_BLOCKS + 1n : floor;
    const logs = await withRetry(() =>
      arcClient.getContractEvents({
        address: config.pokerDeal as `0x${string}`,
        abi: PokerDealAbi,
        eventName: "ShuffleDeckEmitted",
        args: { tableId, producingRound },
        fromBlock: lo,
        toBlock: hi,
      }),
    );
    if (logs.length > 0) {
      // Newest-first scan: this is the most-recent chunk with a match, so the
      // highest-blockNumber log here is the current hand's emission.
      let best = logs[0];
      for (const l of logs) {
        if (
          (l.blockNumber ?? 0n) > (best.blockNumber ?? 0n) ||
          ((l.blockNumber ?? 0n) === (best.blockNumber ?? 0n) &&
            (l.logIndex ?? 0) > (best.logIndex ?? 0))
        ) {
          best = l;
        }
      }
      const deck = toDeck(best as Log);
      return {
        ...deck,
        blockNumber: best.blockNumber ?? 0n,
        producingRound,
      };
    }
    if (lo === floor) break;
    hi = lo - 1n;
  }

  throw new Error(
    `no ShuffleDeckEmitted event for producingRound=${producingRound} on table ` +
      `${tableId} within the last ${EVENT_LOOKBACK_BLOCKS} blocks — the round-` +
      `${producingRound} shuffler may not have submitted yet, or the lookback ` +
      `(ARC_MCP_EVENT_LOOKBACK_BLOCKS) is too small for this hand's duration.`,
  );
}
