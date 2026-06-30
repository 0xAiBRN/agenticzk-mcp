// poker_report_shuffle_da_fault — adjudicate a shuffle data-availability grief.
//
// ZK Shuffle Gas milestone (2026-05-21). The gas-optimised shuffle keeps
// intermediate decks off-chain: each first/mid round emits its output deck in
// a ShuffleDeckEmitted event and binds it on-chain ONLY through a Poseidon
// `outputCommit`. That is sound against forgery — no prover can fake a deck for
// a commitment — but NOT against availability: a malicious round can submit a
// valid proof yet emit a deck whose bytes disagree with the commitment it
// proved. The next shuffler then cannot build a matching proof; if it does
// nothing its shuffle deadline expires and IT — the innocent victim — is
// slashed for "boycott".
//
// This tool is the victim's escape hatch. It builds a `deck_commit` Groth16
// proof over the emitted (disputed) deck and encodes DealSystem.
// reportShuffleDAFault. The contract pins the disputed deck by keccak256
// against `lastEmittedDeckHash`, reads the proven Poseidon commitment, and —
// if it disagrees with the stored chain commitment — slashes the EMITTER
// (roster[round-1]) and voids the hand instead of the stuck shuffler.
//
// Flow:
//   1. Read DealSystem.shuffleRound + handRoster — the table must be stuck at
//      a round r with 1 <= r < roster.length.
//   2. Read the disputed deck — deck_r, emitted by round r-1.
//   3. Pre-check: compute its Poseidon commitment off-chain and compare to the
//      on-chain `deckCommitment`. EQUAL → round r-1 was honest, there is no
//      fault to report (the contract would revert NoShuffleDAFault) → refuse.
//   4. MISMATCH → a real fault. Generate the deck_commit proof and encode
//      reportShuffleDAFault; the caller broadcasts the returned unsignedTx.
//
// Callable by ANY party — a stuck table is everyone's problem.

import { encodeFunctionData } from "viem";
import { readContractWithRetry } from "../chains.js";
import { config } from "../config.js";
import { PokerDealAbi } from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";
import type { Point } from "../zk/shuffle-input.js";
import { deckCommitment } from "../zk/initial-deck.js";
import { deckCommitPoseidon, buildDeckCommitWitness } from "../zk/deck-commit.js";
import { readEmittedDeck } from "../zk/shuffle-events.js";
import { makeDeckCommitProver, proofToSolidityCalldata } from "../zk/prover.js";

type DeckSnapshot = readonly [
  readonly [bigint, bigint],
  readonly (readonly [bigint, bigint])[],
  readonly (readonly [bigint, bigint])[],
  boolean,
  number,
];

export async function pokerReportShuffleDaFaultHandler(args: { tableId: string }) {
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex"));
  }

  // 1. Read current round + roster.
  // audit 2026-05-22 MC-11 — readContractWithRetry explicit (RPC blip yutar).
  let round: number;
  let roster: readonly number[];
  try {
    const snapshot = (await readContractWithRetry({
      address: config.pokerDeal as `0x${string}`,
      abi: PokerDealAbi,
      functionName: "deckSnapshot",
      args: [tableId],
    })) as DeckSnapshot;
    if (!snapshot[3]) {
      return errorResult(
        err("E_DEAL_READ", "DealSystem not initialized for this tableId."),
      );
    }
    round = Number(snapshot[4]);
    roster = (await readContractWithRetry({
      address: config.pokerDeal as `0x${string}`,
      abi: PokerDealAbi,
      functionName: "handRoster",
      args: [tableId],
    })) as readonly number[];
  } catch (e) {
    return errorResult(
      err("E_DEAL_READ", `failed to read DealSystem state: ${(e as Error).message}`),
    );
  }

  // A DA fault can only block round >= 1 (round 0's input is the verifier-bound
  // storage deck) and only while the chain is still running.
  if (round < 1) {
    return errorResult(
      err(
        "E_NO_DA_FAULT_BEFORE_ROUND1",
        `shuffleRound=${round} — round 0's input is the verifier-bound storage ` +
          `deck, so a DA fault can only block round >= 1. Nothing to report.`,
      ),
    );
  }
  if (round >= roster.length) {
    return errorResult(
      err(
        "E_SHUFFLE_COMPLETE",
        `shuffle chain already complete (round=${round}, roster length=${roster.length}) ` +
          `— no stuck shuffler to rescue.`,
      ),
    );
  }

  // 2. Read the disputed deck — deck_r, emitted by round r-1 (the emitter).
  const producingRound = round - 1;
  let disputedC1: Point[];
  let disputedC2: Point[];
  try {
    const emitted = await readEmittedDeck(tableId, producingRound);
    disputedC1 = emitted.c1;
    disputedC2 = emitted.c2;
  } catch (e) {
    return errorResult(
      err(
        "E_INPUT_DECK_READ",
        `failed to read the round-${producingRound} ShuffleDeckEmitted event: ` +
          `${(e as Error).message}`,
      ),
    );
  }

  // 2a. Defensive — the contract pins the disputed deck by keccak256 against
  // `lastEmittedDeckHash`. The event payload is exactly that deck, so this
  // matches by construction; a mismatch means we read a stale/wrong event.
  try {
    const onChainHash = (await readContractWithRetry({
      address: config.pokerDeal as `0x${string}`,
      abi: PokerDealAbi,
      functionName: "lastEmittedDeckHash",
      args: [tableId],
    })) as `0x${string}`;
    const localHash = deckCommitment(disputedC1, disputedC2); // keccak256(abi.encode(c1,c2))
    if (onChainHash.toLowerCase() !== localHash.toLowerCase()) {
      return errorResult(
        err(
          "E_DISPUTED_DECK_MISMATCH",
          `the round-${producingRound} ShuffleDeckEmitted payload (keccak ${localHash}) ` +
            `does not match DealSystem.lastEmittedDeckHash (${onChainHash}) — a ` +
            `newer round may have emitted since, or the event read is stale. Retry.`,
        ),
      );
    }
  } catch (e) {
    return errorResult(
      err("E_DEAL_READ", `failed to read lastEmittedDeckHash: ${(e as Error).message}`),
    );
  }

  // 3. Pre-check: is there actually a fault? Compute the disputed deck's true
  //    Poseidon commitment and compare to the on-chain chain commitment.
  let chainCommit: bigint;
  let trueCommit: bigint;
  try {
    chainCommit = (await readContractWithRetry({
      address: config.pokerDeal as `0x${string}`,
      abi: PokerDealAbi,
      functionName: "deckCommitment",
      args: [tableId],
    })) as bigint;
    trueCommit = await deckCommitPoseidon(disputedC1, disputedC2);
  } catch (e) {
    return errorResult(
      err("E_CHAIN_COMMIT_CHECK", `commitment check failed: ${(e as Error).message}`),
    );
  }
  if (trueCommit === chainCommit) {
    return errorResult(
      err(
        "E_NO_DA_FAULT",
        `round ${producingRound} was honest — the deck it emitted hashes to ` +
          `${trueCommit}, exactly the commitment it proved on-chain. There is no ` +
          `DA fault to report (reportShuffleDAFault would revert NoShuffleDAFault). ` +
          `If round ${round} is genuinely stuck, the round-${round} shuffler is ` +
          `boycotting — arm/expire its deadline with the shuffle-timeout path.`,
        { round, producingRound, commitment: trueCommit.toString() },
      ),
    );
  }

  // 4. A real fault. Prove `claimedCommit == DeckCommit(disputedDeck)` with the
  //    deck_commit circuit so the contract can trust the commitment we report.
  let proof;
  try {
    const witness = buildDeckCommitWitness(disputedC1, disputedC2);
    const prover = makeDeckCommitProver();
    proof = await prover.prove(witness);
  } catch (e) {
    return errorResult(
      err("E_PROVE_FAILED", `deck_commit Groth16 prove failed: ${(e as Error).message}`),
    );
  }

  // deck_commit public-signal layout: [out, c1(104), c2(104)] — out == the
  // genuine Poseidon commitment of the disputed deck (== trueCommit).
  const claimedCommit = BigInt(proof.publicSignals[0]);
  if (claimedCommit !== trueCommit) {
    return errorResult(
      err(
        "E_PROVE_INCONSISTENT",
        `internal error — deck_commit proof output ${claimedCommit} != off-chain ` +
          `commitment ${trueCommit}. Aborting rather than encoding a bad tx.`,
      ),
    );
  }

  const calldata = proofToSolidityCalldata(proof.proof);
  const c1 = disputedC1.map((p) => [p[0], p[1]] as const);
  const c2 = disputedC2.map((p) => [p[0], p[1]] as const);
  const data = encodeFunctionData({
    abi: PokerDealAbi,
    functionName: "reportShuffleDAFault",
    args: [
      tableId,
      claimedCommit,
      c1,
      c2,
      calldata.pA,
      calldata.pB,
      calldata.pC,
    ] as never,
  });

  return okResult({
    unsignedTx: {
      to: config.pokerDeal,
      data,
      value: "0",
      chainId: config.arcChainId,
    },
    tableId,
    round,
    producingRound,
    offenderSeat: roster[producingRound],
    chainCommitment: chainCommit.toString(),
    emittedDeckCommitment: trueCommit.toString(),
    backend: config.zkProverBackend,
    proveMs: Math.round(proof.timings.proveMs),
    totalMs: Math.round(proof.timings.totalMs),
    note:
      `Data-availability fault proven — round ${producingRound} (seat ` +
      `${roster[producingRound]}) emitted a deck that does not match the ` +
      `commitment it proved. Broadcast this tx to slash the emitter and void ` +
      `the hand; the stuck round-${round} shuffler is NOT slashed.`,
  });
}
