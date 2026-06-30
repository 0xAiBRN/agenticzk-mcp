// poker_shuffle_prove — agent's per-hand encrypted shuffle round.
//
// ZK Shuffle Gas milestone (2026-05-21). The shuffle was split from a single
// 418-public-signal circuit into three commitment-chained circuits selected by
// round index. This tool hides that split entirely: the caller still passes a
// tableId and broadcasts the returned `unsignedTx` — the tool reads the round,
// picks the circuit, reads the right input deck, and encodes the matching
// submitShuffleFirst / submitShuffleMid / submitShuffleLast calldata.
//
// Flow (called once per hand by each agent in turn):
//   1. Read DealSystem.shuffleRound + handRoster → classify first / mid / last.
//   2. Read the INPUT deck:
//        round 0      — deck_0 from DealSystem storage (deckSnapshot).
//        round >= 1   — deck_r from round r-1's ShuffleDeckEmitted event
//                       (intermediate decks are not stored on-chain).
//   3. Verify joint pk; for round 0 verify the canonical-deck commitment; for
//      round >= 1 verify the handed deck against the on-chain commitment chain
//      (a mismatch = data-availability grief → caller routed to the DA-fault
//      tool BEFORE wasting a ~20 s proof and being slashed as the victim).
//   4. Pick a fresh permutation σ + per-card randomness r[] (CSPRNG).
//   5. Generate the Groth16 proof for the round-specific circuit.
//   6. Encode the matching submitShuffle* calldata and return unsignedTx.
//
// The chain verifies the proof on-chain and chains the deck commitment so the
// next agent's input is this agent's output.

import { encodeFunctionData } from "viem";
import { readContractWithRetry } from "../chains.js";
import { config } from "../config.js";
import { PokerDealAbi, PokerTableAbi } from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";
import {
  buildShuffleWitness,
  csprngRng,
  seededRng,
  sumBabyJubPoints,
  type Point,
} from "../zk/shuffle-input.js";
import {
  makeShuffleProver,
  proofToSolidityCalldata,
  type ShuffleRole,
} from "../zk/prover.js";
import { buildInitialDeck, deckCommitment } from "../zk/initial-deck.js";
import { deckCommitPoseidon } from "../zk/deck-commit.js";
import { readEmittedDeck } from "../zk/shuffle-events.js";

const DECK_SIZE = 52;
type ChainPoint = readonly [bigint, bigint];
type DeckSnapshot = readonly [
  ChainPoint,
  readonly ChainPoint[],
  readonly ChainPoint[],
  boolean,
  number,
];

// 2026-05-18 — Codex audit P1 fix. expectedRound gating için kısa bekleme
// limiti. RPC'nin gerçekten ilerlemesini bekle ama sonsuz takılma.
const DECK_ROUND_WAIT_MS = Number(process.env.ARC_MCP_DECK_ROUND_WAIT_MS ?? 12_000);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type RawArgs = {
  tableId: string;
  /**
   * Optional 256-bit hex seed for a deterministic permutation — TEST/DEBUG ONLY.
   * audit 2026-05-22 K#2: production MUST omit (CSPRNG). When supplied, the seed
   * is rejected unless `POKER_ALLOW_SEED=1` is set on the MCP server.
   */
  seed?: string;
  /** Default true. Set false only for legacy/B3.6 single-admin smoke tests. */
  verifyJointPk?: boolean;
  /**
   * Optional expected DealSystem.shuffleRound. When set, the tool waits briefly
   * for the RPC node to catch up to that round and refuses stale snapshots
   * before generating the (~20 s) Groth16 proof.
   */
  expectedRound?: number;
};

type Snapshot = { pk: Point; c1: Point[]; c2: Point[]; round: number };
type InputDeck = { inputC1: Point[]; inputC2: Point[] };
type ToolErr = ReturnType<typeof errorResult>;

export async function pokerShuffleProveHandler(args: RawArgs) {
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex"));
  }

  // 1. Read deck snapshot (pk + current round, with expectedRound gating).
  const snapRes = await _readSnapshotWithGating(tableId, args.expectedRound);
  if ("error" in snapRes) return snapRes.error;
  const snap = snapRes.snap;

  // 2. Read the active hand roster → classify this round into first/mid/last.
  const rosterRes = await _readRoster(tableId);
  if ("error" in rosterRes) return rosterRes.error;
  const roster = rosterRes.roster;
  const round = snap.round;
  if (round >= roster.length) {
    return errorResult(
      err(
        "E_SHUFFLE_COMPLETE",
        `shuffle chain already complete — shuffleRound=${round}, roster length=${roster.length}.`,
      ),
    );
  }
  const role = classifyRound(round, roster.length);

  // 3. Resolve the INPUT deck for this round (storage for first, event for rest).
  const inputRes = await _resolveInputDeck(tableId, role, round, snap);
  if ("error" in inputRes) return inputRes.error;
  const { inputC1, inputC2 } = inputRes;

  // 3a. Self-verify joint pk (B3.7.B-4 — trust-but-verify).
  if (args.verifyJointPk ?? true) {
    const jpkErr = await _verifyJointPk(tableId, snap.pk, roster);
    if (jpkErr) return jpkErr;
  }

  // 3b. Verify the INPUT deck's integrity (canonical for round 0, commit-chain for round >= 1).
  const deckErr = await _verifyInputDeckIntegrity(tableId, role, round, snap.pk, inputC1, inputC2);
  if (deckErr) return deckErr;

  // 4. Pick randomness, build witness + output ciphertexts.
  const witnessRes = await _buildWitness(args.seed, snap.pk, inputC1, inputC2);
  if ("error" in witnessRes) return witnessRes.error;
  const witnessInput = witnessRes.witnessInput;

  // 5. Groth16 prove via the round-specific circuit.
  let proof;
  try {
    const prover = makeShuffleProver(role);
    proof = await prover.prove(witnessInput.witness);
  } catch (e) {
    return errorResult(
      err("E_PROVE_FAILED", `Groth16 prove failed (${role} circuit): ${(e as Error).message}`),
    );
  }

  // 6. Encode the matching submitShuffle* calldata and return unsignedTx.
  return _buildResult(tableId, role, round, proof, witnessInput);
}

// ---------------------------------------------------------------------------
// Helpers (module-private). Handler stays short; each numbered step lives in
// its own factor so it can be unit-tested or replaced in isolation.
// ---------------------------------------------------------------------------

function mapChainDeckPoints(raw: readonly ChainPoint[], field: string): Point[] {
  if (raw.length !== DECK_SIZE) {
    throw new Error(
      `DealSystem.deckSnapshot returned ${raw.length} ${field} entries; expected ${DECK_SIZE}`,
    );
  }
  return raw.map((p) => [p[0], p[1]] as Point);
}

/**
 * Self-verify: independently sum the session pks the contract has on file
 * for this table and assert it equals the deck's stored joint pk. If not,
 * the coordinator (or contract) is lying about which pk the deck was sealed
 * under, and the agent's shuffle proof would re-encrypt under a pk no one
 * actually controls — bricking the hand and possibly leaking plaintext.
 *
 * G14 (2026-05-06) — `deckPk` on-chain is Σ pk_i over only the *active hand
 * roster* (DealSystem._handRoster snapshot taken at initDeal). sessionPks
 * still contains keys for eliminated agents, so filter by the active roster
 * before summing — otherwise this self-check would always fail post-elimination.
 *
 * @param roster the active hand roster (seat indexes), read once by the caller.
 * Returns null on success; non-null reason string on mismatch.
 */
// audit 2026-05-22 MC-11 — verifyJointPkAgainstSessionPks içindeki read'ler
// readContractWithRetry kullanır (caller try/catch ile sarmalanmış).
async function verifyJointPkAgainstSessionPks(
  tableId: `0x${string}`,
  storedPk: Point,
  roster: readonly number[],
): Promise<string | null> {
  const entries = (await readContractWithRetry({
    address: config.pokerDeal as `0x${string}`,
    abi: PokerDealAbi,
    functionName: "getSessionPks",
    args: [tableId],
  })) as readonly { agent: `0x${string}`; pkX: bigint; pkY: bigint }[];

  if (entries.length === 0) {
    return "no session pks published — joint pk has no agent-side attestation";
  }
  if (roster.length === 0) {
    return "handRoster empty — DealSystem.initDeal must precede shuffle prove";
  }

  // G14 active-roster filter — resolve each seat → player address, keep only
  // the sessionPk entries whose agent is part of this hand's deckPk.
  const seatPlayers = await Promise.all(
    roster.map((seat) =>
      readContractWithRetry({
        address: config.pokerTable as `0x${string}`,
        abi: PokerTableAbi,
        functionName: "getSeat",
        args: [tableId, seat],
      }) as Promise<{ player: `0x${string}` }>,
    ),
  );
  const activeSet = new Set(
    seatPlayers.map((s) => s.player.toLowerCase() as `0x${string}`),
  );
  const activeEntries = entries.filter((e) =>
    activeSet.has(e.agent.toLowerCase() as `0x${string}`),
  );

  if (activeEntries.length === 0) {
    return (
      `no session pk found for any of ${roster.length} active hand-roster ` +
      `seat(s) — coordinator may not have aggregated keys for the current hand`
    );
  }
  if (activeEntries.length !== roster.length) {
    return (
      `incomplete session pks — ${activeEntries.length} of ${roster.length} ` +
      `active hand-roster seats have published a key; cannot shuffle under ` +
      `partial joint pk`
    );
  }

  const recomputed = await sumBabyJubPoints(
    activeEntries.map((e) => [e.pkX, e.pkY] as Point),
  );
  if (recomputed[0] !== storedPk[0] || recomputed[1] !== storedPk[1]) {
    return (
      `joint pk mismatch — chain says (${storedPk[0]}, ${storedPk[1]}) but Σ ` +
      `${activeEntries.length} active-roster pk_i = (${recomputed[0]}, ${recomputed[1]}). ` +
      `Refusing to shuffle under an unattested pk.`
    );
  }
  return null;
}

/**
 * F-03 — verify the seeded initial deck is the canonical 52-card set. The deck
 * is deterministic given the joint pk; recompute it, hash it exactly as
 * `DealSystem.initDeal` does (`keccak256(abi.encode(c1,c2))`), and compare
 * against the on-chain `deckCommitmentOf`. Only meaningful for ROUND 0 — that
 * keccak commitment is to deck_0; intermediate decks are bound by the Poseidon
 * commitment chain instead. Returns null on success; reason string on mismatch.
 */
async function verifyCanonicalDeck(
  tableId: `0x${string}`,
  jointPk: Point,
): Promise<string | null> {
  const onChain = (await readContractWithRetry({
    address: config.pokerDeal as `0x${string}`,
    abi: PokerDealAbi,
    functionName: "deckCommitmentOf",
    args: [tableId],
  })) as `0x${string}`;

  if (!onChain || /^0x0*$/.test(onChain)) {
    return (
      "DealSystem.deckCommitmentOf is empty — initDeal did not commit a deck " +
      "hash. Refusing to shuffle without a verifiable canonical-deck commitment."
    );
  }

  const canonical = await buildInitialDeck(jointPk);
  const expected = deckCommitment(canonical.c1, canonical.c2);
  if (expected.toLowerCase() !== onChain.toLowerCase()) {
    return (
      `initial deck is NOT canonical — DealSystem committed ${onChain}, but the ` +
      `canonical 52-card deck recomputed from the joint pk hashes to ${expected}. ` +
      `The coordinator may have seeded duplicate, missing or biased cards. ` +
      `Refusing to shuffle a forged deck.`
    );
  }
  return null;
}

/** Read pk + round from DealSystem.deckSnapshot (storage deck = deck_0). */
async function readDeckSnapshot(
  tableId: `0x${string}`,
): Promise<Snapshot> {
  const snapshot = (await readContractWithRetry({
    address: config.pokerDeal as `0x${string}`,
    abi: PokerDealAbi,
    functionName: "deckSnapshot",
    args: [tableId],
  })) as DeckSnapshot;

  const [pkRaw, c1Raw, c2Raw, isInit, roundRaw] = snapshot;
  if (!isInit) {
    throw new Error(
      "DealSystem not initialized for this tableId — call DealSystem.initDeal first.",
    );
  }
  return {
    pk: [pkRaw[0], pkRaw[1]],
    c1: mapChainDeckPoints(c1Raw, "c1"),
    c2: mapChainDeckPoints(c2Raw, "c2"),
    round: Number(roundRaw),
  };
}

/** Classify a shuffle round into its circuit role given the roster length. */
function classifyRound(round: number, rosterLength: number): ShuffleRole {
  if (round === 0) return "first";
  if (round === rosterLength - 1) return "last";
  return "mid";
}

// Step 1 — read DealSystem snapshot, optionally wait for RPC to catch up to
// the caller-supplied expectedRound, then refuse stale snapshots so we never
// burn a ~20 s proof against deck_0 when the chain is already at deck_n.
async function _readSnapshotWithGating(
  tableId: `0x${string}`,
  expectedRound: number | undefined,
): Promise<{ snap: Snapshot } | { error: ToolErr }> {
  let snap: Snapshot;
  const waitDeadline = Date.now() + DECK_ROUND_WAIT_MS;
  try {
    snap = await readDeckSnapshot(tableId);
    while (
      expectedRound !== undefined &&
      snap.round < expectedRound &&
      Date.now() < waitDeadline
    ) {
      await sleep(500);
      snap = await readDeckSnapshot(tableId);
    }
  } catch (e) {
    return {
      error: errorResult(
        err("E_DEAL_READ", `failed to read DealSystem state: ${(e as Error).message}`),
      ),
    };
  }
  if (expectedRound !== undefined && snap.round < expectedRound) {
    return {
      error: errorResult(
        err(
          "E_DECK_STALE",
          `DealSystem.shuffleRound=${snap.round} but caller expected ${expectedRound}; refusing to prove against stale deck snapshot.`,
        ),
      ),
    };
  }
  return { snap };
}

// Step 2 — read DealSystem.handRoster, enforce minimum participant count.
async function _readRoster(
  tableId: `0x${string}`,
): Promise<{ roster: readonly number[] } | { error: ToolErr }> {
  let roster: readonly number[];
  try {
    roster = (await readContractWithRetry({
      address: config.pokerDeal as `0x${string}`,
      abi: PokerDealAbi,
      functionName: "handRoster",
      args: [tableId],
    })) as readonly number[];
  } catch (e) {
    return {
      error: errorResult(
        err("E_DEAL_READ", `failed to read DealSystem.handRoster: ${(e as Error).message}`),
      ),
    };
  }
  if (roster.length < 2) {
    return {
      error: errorResult(
        err(
          "E_DEAL_READ",
          `handRoster has ${roster.length} seat(s) — initDeal must precede shuffle prove (needs >= 2).`,
        ),
      ),
    };
  }
  return { roster };
}

// Step 3 — resolve INPUT deck for this round.
//   round 0    — deck_0 from storage (the deckSnapshot we already have).
//   round >= 1 — deck_r from round r-1's ShuffleDeckEmitted event.
async function _resolveInputDeck(
  tableId: `0x${string}`,
  role: ShuffleRole,
  round: number,
  snap: Snapshot,
): Promise<InputDeck | { error: ToolErr }> {
  if (role === "first") {
    return { inputC1: snap.c1, inputC2: snap.c2 };
  }
  try {
    const emitted = await readEmittedDeck(tableId, round - 1);
    return { inputC1: emitted.c1, inputC2: emitted.c2 };
  } catch (e) {
    return {
      error: errorResult(
        err(
          "E_INPUT_DECK_READ",
          `failed to read the round-${round - 1} ShuffleDeckEmitted event ` +
            `(input deck for round ${round}): ${(e as Error).message}`,
        ),
      ),
    };
  }
}

// Step 3a — wrap verifyJointPkAgainstSessionPks with the handler's error envelope.
async function _verifyJointPk(
  tableId: `0x${string}`,
  storedPk: Point,
  roster: readonly number[],
): Promise<ToolErr | null> {
  try {
    const reason = await verifyJointPkAgainstSessionPks(tableId, storedPk, roster);
    if (reason) return errorResult(err("E_JOINT_PK_UNATTESTED", reason));
    return null;
  } catch (e) {
    return errorResult(
      err("E_JOINT_PK_CHECK", `joint pk verification failed: ${(e as Error).message}`),
    );
  }
}

// Step 3b — verify INPUT deck integrity. For round 0, the input is deck_0;
// verify it is the canonical 52-card set against the on-chain keccak
// commitment. UNCONDITIONAL — every agent MUST refuse a forged seed.
// For round >= 1, the input deck came from an event, which is NOT
// verifier-bound. Cross-check it against the on-chain Poseidon commitment
// chain: a mismatch means round r-1 emitted a deck inconsistent with the
// `outputCommit` it proved — a data-availability grief. If we shuffled
// anyway the tx would revert (CommitmentChainBroken) AND, worse, our
// shuffle deadline would expire and we — the victim — would be slashed for
// "boycott". Detect it here, in milliseconds, and route to the DA-fault
// tool which slashes the round-(r-1) emitter instead.
async function _verifyInputDeckIntegrity(
  tableId: `0x${string}`,
  role: ShuffleRole,
  round: number,
  jointPk: Point,
  inputC1: Point[],
  inputC2: Point[],
): Promise<ToolErr | null> {
  if (role === "first") {
    try {
      const deckReason = await verifyCanonicalDeck(tableId, jointPk);
      if (deckReason) return errorResult(err("E_NON_CANONICAL_DECK", deckReason));
      return null;
    } catch (e) {
      return errorResult(
        err("E_DECK_CHECK", `canonical deck verification failed: ${(e as Error).message}`),
      );
    }
  }

  let chainCommit: bigint;
  let handedCommit: bigint;
  try {
    chainCommit = (await readContractWithRetry({
      address: config.pokerDeal as `0x${string}`,
      abi: PokerDealAbi,
      functionName: "deckCommitment",
      args: [tableId],
    })) as bigint;
    handedCommit = await deckCommitPoseidon(inputC1, inputC2);
  } catch (e) {
    return errorResult(
      err("E_CHAIN_COMMIT_CHECK", `commitment-chain check failed: ${(e as Error).message}`),
    );
  }
  if (handedCommit !== chainCommit) {
    return errorResult(
      err(
        "E_SHUFFLE_DA_GRIEF",
        `the deck handed to round ${round} (emitted by round ${round - 1}) ` +
          `does not match the on-chain commitment chain — round ${round - 1} ` +
          `committed ${chainCommit} but emitted a deck that hashes to ` +
          `${handedCommit}. You were data-availability griefed. Do NOT submit ` +
          `a shuffle (it would revert AND your deadline would expire, slashing ` +
          `you as the boycott victim). Call poker_report_shuffle_da_fault to ` +
          `slash the round-${round - 1} emitter instead.`,
        {
          round,
          producingRound: round - 1,
          onChainCommitment: chainCommit.toString(),
          handedDeckCommitment: handedCommit.toString(),
        },
      ),
    );
  }
  return null;
}

// Step 4 — pick randomness + build the shuffle witness.
// audit 2026-05-22 K#2 — deterministik `seed` yalnız test/debug içindir.
// Production'da seed verilirse rakip aynı permütasyon + r[]'yi yeniden üretip
// shuffle'ı önceden tahmin eder (gizlilik kaybı). POKER_ALLOW_SEED env flag'i
// olmadan seed reddedilir; smoke koşumları bu flag'i açıkça set eder.
async function _buildWitness(
  seed: string | undefined,
  pk: Point,
  inputC1: Point[],
  inputC2: Point[],
): Promise<{ witnessInput: Awaited<ReturnType<typeof buildShuffleWitness>> } | { error: ToolErr }> {
  if (seed && process.env.POKER_ALLOW_SEED !== "1") {
    return {
      error: errorResult(
        err(
          "E_SEED_NOT_ALLOWED",
          "deterministic 'seed' is test-only — production must omit it (CSPRNG is " +
            "used by default). Set POKER_ALLOW_SEED=1 on the MCP server to permit " +
            "it for smoke tests.",
        ),
      ),
    };
  }
  let rng;
  if (seed) {
    let seedBig: bigint;
    try {
      seedBig = BigInt(seed.startsWith("0x") ? seed : `0x${seed}`);
    } catch {
      return {
        error: errorResult(err("E_INVALID_SEED", "seed must be a hex-encoded 256-bit number")),
      };
    }
    rng = seededRng(seedBig);
  } else {
    rng = csprngRng();
  }

  try {
    const witnessInput = await buildShuffleWitness({ pk, inputC1, inputC2 }, rng);
    return { witnessInput };
  } catch (e) {
    return {
      error: errorResult(
        err("E_WITNESS_BUILD", `failed to build shuffle witness: ${(e as Error).message}`),
      ),
    };
  }
}

// Step 6 — encode the matching submitShuffle* calldata, return unsignedTx + meta.
// Public-signal layout (outputs first):
//   first = [outputCommit, pk(2), inputC1(104), inputC2(104)]
//   mid   = [inputCommit, outputCommit, pk(2)]
//   last  = [inputCommit, pk(2), outputC1(104), outputC2(104)]
function _buildResult(
  tableId: `0x${string}`,
  role: ShuffleRole,
  round: number,
  proof: Awaited<ReturnType<ReturnType<typeof makeShuffleProver>["prove"]>>,
  witnessInput: Awaited<ReturnType<typeof buildShuffleWitness>>,
) {
  const calldata = proofToSolidityCalldata(proof.proof);
  const outC1 = witnessInput.outputC1.map((p) => [p[0], p[1]] as const);
  const outC2 = witnessInput.outputC2.map((p) => [p[0], p[1]] as const);

  const pub = proof.publicSignals;
  let data: `0x${string}`;
  let functionName: string;
  if (role === "first") {
    const outputCommit = BigInt(pub[0]);
    functionName = "submitShuffleFirst";
    data = encodeFunctionData({
      abi: PokerDealAbi,
      functionName: "submitShuffleFirst",
      args: [tableId, outputCommit, outC1, outC2, calldata.pA, calldata.pB, calldata.pC] as never,
    });
  } else if (role === "mid") {
    const inputCommit = BigInt(pub[0]);
    const outputCommit = BigInt(pub[1]);
    functionName = "submitShuffleMid";
    data = encodeFunctionData({
      abi: PokerDealAbi,
      functionName: "submitShuffleMid",
      args: [
        tableId,
        inputCommit,
        outputCommit,
        outC1,
        outC2,
        calldata.pA,
        calldata.pB,
        calldata.pC,
      ] as never,
    });
  } else {
    const inputCommit = BigInt(pub[0]);
    functionName = "submitShuffleLast";
    data = encodeFunctionData({
      abi: PokerDealAbi,
      functionName: "submitShuffleLast",
      args: [tableId, inputCommit, outC1, outC2, calldata.pA, calldata.pB, calldata.pC] as never,
    });
  }

  // Verify gas is round-dependent: first/last bind a 52-card anchor deck as
  // public signals (~2.1M verify); mid is the 4-signal commitment-only circuit
  // (~240k). The legacy single circuit was ~3.9M for every round.
  const verifyGasNote =
    role === "mid"
      ? "~240k gas (4-signal commitment-only circuit)"
      : "~2.1M gas (211-signal anchor-deck circuit)";

  return okResult({
    unsignedTx: {
      to: config.pokerDeal,
      data,
      value: "0",
      chainId: config.arcChainId,
    },
    tableId,
    round,
    role,
    functionName,
    backend: config.zkProverBackend,
    proveMs: Math.round(proof.timings.proveMs),
    totalMs: Math.round(proof.timings.totalMs),
    note:
      `Shuffle proof generated via the ${role} circuit (${config.zkProverBackend} ` +
      `backend). On-chain verify cost ${verifyGasNote}; orchestrator should ` +
      `broadcast this tx and wait for the ShuffleAccepted event before the next ` +
      `action.`,
  });
}
