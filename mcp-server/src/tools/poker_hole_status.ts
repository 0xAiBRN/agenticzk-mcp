// poker_hole_status — per-hole-card decrypt obligations for a Path-B harness.
//
// 2026-06-22 (Path B build, FIX-C / adversarial-review gap). poker_round_status
// surfaces only COMMUNITY-card decrypt status; a Path-B agent has no MCP read to
// learn which HOLE cards it owes a non-owner share for, nor which two cards are
// its own (to recover with poker_recover_card). That math previously lived only
// in agent-runner (holeIdxsAll + probeCardShares). This pure read tool exposes it.
//
// Roster-index math (DecryptSystem.sol:38-39 _dealRoleOf): for an N-seat hand,
// cardIdx 0..2N-1 are hole cards, and the OWNER of cardIdx is the seat at ROSTER
// position (cardIdx % N) — i.e. handRoster[cardIdx % N], NOT a seat index. The
// per-seat pair is therefore { i, i + N } for roster slot i (== holeIdxsAll in
// the production state-machine). Ownership is read authoritatively from the
// contract getter holeOwnerOf(tableId, cardIdx); `isMine` = holeOwnerOf == player
// (case-insensitive). We never recompute ownership from a local roster snapshot —
// the on-chain getter is the single source of truth and already applies cardIdx%N.
//
// PK-safety: PURE READ. Encodes no tx, holds no key, signs nothing.

import { readContractWithRetry } from "../chains.js";
import { config } from "../config.js";
import { PokerDealAbi, PokerDecryptAbi } from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Hole card indexes for an N-seat hand, in roster order: { i, i+N } per slot.
 *  Mirrors agent-runner holeIdxsAll(rosterLen). Spans cardIdx 0..2N-1. */
function holeIdxsAll(rosterLen: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < rosterLen; i++) {
    out.push(i, i + rosterLen);
  }
  return out;
}

export async function pokerHoleStatusHandler(args: {
  tableId: string;
  player: string;
}) {
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66 || !tableId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex"));
  }
  const player = (args.player ?? "").toLowerCase();
  if (!player || player.length !== 42 || !player.startsWith("0x")) {
    return errorResult(err("E_INVALID_PLAYER", "player must be a 20-byte hex address"));
  }

  // 1. Active hand roster (chips>0 snapshot at initDeal). N = roster length drives
  //    the hole-card index math + each card's required-share threshold (N-1).
  let handRoster: readonly number[];
  try {
    handRoster = (await readContractWithRetry({
      address: config.pokerDeal as `0x${string}`,
      abi: PokerDealAbi,
      functionName: "handRoster",
      args: [tableId],
    })) as readonly number[];
  } catch (e) {
    return errorResult(err("E_READ_FAILED", `handRoster read failed: ${(e as Error).message}`));
  }

  const N = handRoster.length;
  if (N === 0) {
    // Pre-initDeal (WaitingForPlayers / between hands): no hole cards yet.
    return okResult({
      tableId,
      player: args.player,
      handRosterCount: 0,
      cards: [],
      iOwe: [],
      myCardIdxs: [],
      note: "handRoster is empty (deal not initialized) — no hole cards to decrypt yet. Run poker_hand_start / shuffle first, then re-read.",
    });
  }

  const holeIdxs = holeIdxsAll(N);

  // 2. Per-hole-card reads (parallel). Each card needs:
  //    holeOwnerOf       — authoritative owner (== handRoster[cardIdx % N] player)
  //    requiredSharesFor — N-1 for a hole card (the non-owner threshold)
  //    shareCount        — distinct non-owner shares submitted this hand epoch
  //    revealed          — true once shareCount reached the N-1 threshold
  //    ownerShareSubmitted — owner's own showdown share landed (Showdown only)
  let cards: Array<{
    cardIdx: number;
    holeOwner: string;
    isMine: boolean;
    revealed: boolean;
    shareCount: number;
    requiredShares: number;
    ownerShareSubmitted: boolean;
    iContributed: boolean;
  }>;
  try {
    const reads = holeIdxs.flatMap((idx) => [
      readContractWithRetry({
        address: config.pokerDecrypt as `0x${string}`,
        abi: PokerDecryptAbi,
        functionName: "holeOwnerOf",
        args: [tableId, idx],
      }) as Promise<`0x${string}`>,
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
      readContractWithRetry({
        address: config.pokerDecrypt as `0x${string}`,
        abi: PokerDecryptAbi,
        functionName: "ownerShareSubmitted",
        args: [tableId, idx],
      }) as Promise<boolean>,
      // B1 (Codex review 2026-06-22) — MY own already-submitted non-owner share.
      // getShare returns (x, y); a non-zero y means I already contributed for this
      // card (re-submitting reverts DuplicateContributor). Without this, iOwe kept
      // listing a card while the AGGREGATE threshold was still unmet (3+ player
      // hands, a peer not yet submitted) → repeated DuplicateContributor reverts.
      readContractWithRetry({
        address: config.pokerDecrypt as `0x${string}`,
        abi: PokerDecryptAbi,
        functionName: "getShare",
        args: [tableId, idx, args.player],
      }) as Promise<readonly [bigint, bigint]>,
    ]);
    const results = await Promise.all(reads);
    const READS_PER_CARD = 6;
    cards = holeIdxs.map((idx, i) => {
      const base = i * READS_PER_CARD;
      const holeOwnerRaw = ((results[base] as `0x${string}`) ?? ZERO_ADDRESS).toLowerCase();
      const myShare = (results[base + 5] as readonly [bigint, bigint] | undefined) ?? [0n, 0n];
      return {
        cardIdx: idx,
        holeOwner: holeOwnerRaw,
        // isMine derived strictly from the on-chain owner getter (cardIdx % N).
        isMine: holeOwnerRaw !== ZERO_ADDRESS && holeOwnerRaw === player,
        revealed: Boolean(results[base + 3]),
        shareCount: Number(results[base + 2]),
        requiredShares: Number(results[base + 1]),
        ownerShareSubmitted: Boolean(results[base + 4]),
        // B1: my own non-owner share already on-chain for this card (y != 0).
        iContributed: BigInt(myShare[1] ?? 0n) !== 0n,
      };
    });
  } catch (e) {
    return errorResult(
      err("E_DECRYPT_READ", `hole decrypt status read failed: ${(e as Error).message}`),
    );
  }

  // 3. Derived caller-centric lists.
  //    iOwe — PEERS' hole cards still needing my NON-owner share: not mine, not
  //           yet revealed, threshold not met. (Mirrors agent-runner
  //           holeCardsNeedingMyNonOwnerShare — withholding MY share keeps my own
  //           card private, so my cards are excluded.)
  //    myCardIdxs — my own two hole cards (recover with poker_recover_card).
  const iOwe = cards
    .filter(
      (c) =>
        !c.isMine &&
        c.holeOwner !== ZERO_ADDRESS &&
        !c.revealed &&
        c.shareCount < c.requiredShares &&
        !c.iContributed, // B1: skip cards I already submitted a share for (else DuplicateContributor)
    )
    .map((c) => c.cardIdx);
  const myCardIdxs = cards.filter((c) => c.isMine).map((c) => c.cardIdx);

  const note =
    iOwe.length > 0
      ? `You owe a NON-owner decrypt share for cardIdx ${iOwe.join(", ")} (poker_decrypt_share / poker_decrypt_batch, ≤5 per call). Your own cards are ${myCardIdxs.join(", ") || "(unknown — owner getter returned zero; re-read after deal)"} — recover them with poker_recover_card. NEVER submit a share for your own card.`
      : `No non-owner shares owed right now. Your own cards: ${myCardIdxs.join(", ") || "(unknown)"} — recover with poker_recover_card.`;

  return okResult({
    tableId,
    player: args.player,
    handRoster: handRoster.map((s) => Number(s)),
    handRosterCount: N,
    cards,
    iOwe,
    myCardIdxs,
    note,
  });
}
