// Minimal ABI subset for AgenticZK contracts (M6.A redeploy 2026-04-26).
// Each ABI captures only the functions / events the poker tools call — keeps
// the bundle tight and the typed function names tractable for tool dispatch.

export const PokerOrchestratorAbi = [
  {
    type: "function", name: "createTournament",
    inputs: [
      { name: "tournamentId", type: "bytes32" },
      { name: "token", type: "address" },
      { name: "entryFee", type: "uint256" },
      { name: "minPlayers", type: "uint8" },
      { name: "maxPlayers", type: "uint8" },
      { name: "registrationDeadline", type: "uint64" },
      { name: "payoutBps", type: "uint16[]" },
      { name: "reputationDelta", type: "int64[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "register",
    inputs: [
      { name: "tournamentId", type: "bytes32" },
      { name: "agentId", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "depositFor",
    inputs: [
      { name: "tournamentId", type: "bytes32" },
      { name: "agentId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "start",
    inputs: [{ name: "tournamentId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // 2026-06-22 (Path B build, FIX-4) — the legacy finalize(bytes32,uint256[])
  // (selector 0x2db4cc62) was REMOVED from the deployed orchestrator; finalize is
  // automatic via the table→orchestrator callback (poker_invoke_showdown on the
  // final hand), with poker_retry_tournament_finalize as the parked-finalize
  // recovery rail. The dead fragment + poker_finalize_tournament tool are deleted
  // so no agent encodes a guaranteed-revert tx.
  {
    // 8-output form — matches TournamentOrchestrator.tournamentOf, which returns
    // registrationDeadline as the 8th value. The earlier 7-output fragment
    // silently dropped the deadline, so the MCP could not tell whether a
    // tournament's registration window was still open (needed for open-game
    // discovery). Names are cosmetic (decode is positional); `creator` mirrors
    // the contract's field name.
    type: "function", name: "tournamentOf",
    inputs: [{ name: "tournamentId", type: "bytes32" }],
    outputs: [
      { name: "creator", type: "address" },
      { name: "token", type: "address" },
      { name: "entryFee", type: "uint256" },
      { name: "minPlayers", type: "uint8" },
      { name: "maxPlayers", type: "uint8" },
      { name: "registered", type: "uint8" },
      { name: "phase", type: "uint8" },
      { name: "registrationDeadline", type: "uint64" },
    ],
    stateMutability: "view",
  },
  {
    // Public mapping getter (`mapping(bytes32 => bytes32) public tableIdOf`).
    // The orchestrator-pinned tableId for a tournament — public on-chain source
    // for the table id, so it no longer has to be handed to the player out of band.
    type: "function", name: "tableIdOf",
    inputs: [{ name: "tournamentId", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    // Public mapping getter (`mapping(bytes32 => address) public tableSystemOf`).
    type: "function", name: "tableSystemOf",
    inputs: [{ name: "tournamentId", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    // Emitted by createTournament — the discovery anchor for open-game scanning.
    type: "event", name: "TournamentCreated",
    inputs: [
      { name: "tournamentId", type: "bytes32", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "entryFee", type: "uint256", indexed: false },
      { name: "minPlayers", type: "uint8", indexed: false },
      { name: "maxPlayers", type: "uint8", indexed: false },
      { name: "registrationDeadline", type: "uint64", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "function", name: "rosterOf",
    inputs: [{ name: "tournamentId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256[]" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "isRegistered",
    inputs: [
      { name: "tournamentId", type: "bytes32" },
      { name: "agentId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  // 2026-06-22 (Path B build, FIX-1) — EIP-3009 atomic register is the ONLY
  // working register path for public-USDC tournaments (the legacy
  // transfer→depositFor→register chain reverts DepositForDisabledForPublicUsdc
  // when isPublicUsdcOnly()==true). The MCP returns a PK-safe RECIPE for this
  // (selector 0xb704dd06); the harness signer (scripts/register-eip3009.ts)
  // produces the EIP-3009 signature + the final calldata — the MCP never signs.
  {
    type: "function", name: "registerWithAuthorization",
    inputs: [
      { name: "tournamentId", type: "bytes32" },
      { name: "agentId", type: "uint256" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // isPublicUsdcOnly() — gate read. When true, depositFor is disabled and the
  // legacy poker_register_for_tournament chain must be refused (FIX-1 fail-closed
  // gate) in favour of poker_register_with_authorization.
  {
    type: "function", name: "isPublicUsdcOnly",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  // isOwnerRegistered(tournamentId, owner) — preflight to catch a double-register
  // (the player wallet already holds a seat) before the user wastes a tx.
  {
    type: "function", name: "isOwnerRegistered",
    inputs: [
      { name: "tournamentId", type: "bytes32" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  // 2026-05-11 — P0-4 son kullanici akisi tool'lari icin claim entries.
  // MS-2 pull-over-push: finalize pendingPayout'u, cancel ise pendingRefund'u
  // yazar; agent owner kendisi pull eder. depositFor sonrasi kullanilmayan
  // bakiye withdrawPendingDeposit ile geri cekilir (Registering/Running'de).
  {
    type: "function", name: "claimPayout",
    inputs: [
      { name: "tournamentId", type: "bytes32" },
      { name: "agentId", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "claimRefund",
    inputs: [
      { name: "tournamentId", type: "bytes32" },
      { name: "agentId", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "withdrawPendingDeposit",
    inputs: [
      { name: "tournamentId", type: "bytes32" },
      { name: "agentId", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // Views — son kullanici claim oncesi 0 mi diye kontrol edebilsin.
  {
    type: "function", name: "pendingPayout",
    inputs: [
      { name: "tournamentId", type: "bytes32" },
      { name: "agentId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "pendingRefund",
    inputs: [
      { name: "tournamentId", type: "bytes32" },
      { name: "agentId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    // pendingDeposit[tournamentId][depositor][agentId] -> uint256
    type: "function", name: "pendingDeposit",
    inputs: [
      { name: "tournamentId", type: "bytes32" },
      { name: "depositor", type: "address" },
      { name: "agentId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export const PokerTableAbi = [
  {
    type: "function", name: "joinTable",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "seatIdx", type: "uint8" },
      { name: "agentId", type: "bytes32" },
      { name: "buyInChips", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "leaveTable",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    // Full Seat struct from TableSystem.sol — field NAMES are advisory but
    // ORDER + TYPES are load-bearing for ABI decoding. Previous shorter shape
    // collapsed `occupied`/`inHand`/`folded` into `handContribution`/`folded`/
    // `active` and dropped `allIn` + `currentBet`, so seat.folded actually
    // returned seat.inHand. Action-loop fold detection broke silently.
    type: "function", name: "getSeat",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "seatIdx", type: "uint8" },
    ],
    outputs: [
      {
        name: "", type: "tuple",
        components: [
          { name: "player",            type: "address" },
          { name: "agentId",           type: "bytes32" },
          { name: "chips",             type: "uint256" },
          { name: "occupied",          type: "bool"    },
          { name: "inHand",            type: "bool"    },
          { name: "folded",            type: "bool"    },
          { name: "allIn",             type: "bool"    },
          { name: "currentBet",        type: "uint256" },
          { name: "handContribution",  type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function", name: "activeSeats",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint8[]" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "occupiedSeats",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint8[]" }],
    stateMutability: "view",
  },
  {
    // G14 — Sonraki ele girmeye uygun seat listesi (occupied + chips > 0).
    // poker_hand_start joint pk hesabını bu seat'lerin agent'larına filtre
    // uygulayarak yapar; eliminated seat'lerin session pk'sı toplama dahil
    // edilmez (yoksa on-chain initDeal JointPkMismatch revert eder).
    type: "function", name: "nextHandSeats",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint8[]" }],
    stateMutability: "view",
  },
  {
    // G14 — Şu an aktif eldeki seat listesi (occupied + inHand).
    type: "function", name: "handSeats",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint8[]" }],
    stateMutability: "view",
  },
  {
    // TableSystem.advancePhase — onlyAuthorizedSystem (admin or pre-authorized).
    // Returns the new Phase enum (1=Preflop, 2=Flop, 3=Turn, 4=River, 5=Showdown, 6=Complete).
    type: "function", name: "advancePhase",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "newPhase", type: "uint8" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "getTable",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [
      {
        name: "", type: "tuple",
        components: [
          { name: "admin", type: "address" },
          { name: "maxSeats", type: "uint8" },
          { name: "occupiedCount", type: "uint8" },
          { name: "smallBlind", type: "uint256" },
          { name: "bigBlind", type: "uint256" },
          { name: "minBuyIn", type: "uint256" },
          { name: "maxBuyIn", type: "uint256" },
          { name: "dealerButton", type: "uint8" },
          { name: "currentActor", type: "uint8" },
          { name: "handNumber", type: "uint64" },
          { name: "phase", type: "uint8" }, // 0..6 = WaitingForPlayers..Complete
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;

export const PokerBetAbi = [
  {
    // BetSystem.initRound — onlyAuthorizedSystem. Coordinator calls this after
    // TableSystem.advancePhase moves the phase to Flop/Turn/River so that
    // BetSystem resets the round-level RoundState (currentBet=0 postflop, BB
    // preflop). Without this, `act` reverts with TableNotInitialized.
    type: "function", name: "initRound",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    // action enum: 0=Fold, 1=Check, 2=Call, 3=Raise, 4=AllIn
    type: "function", name: "act",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "action", type: "uint8" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    // RoundState as declared in BetSystem.sol (field order + types are
    // load-bearing for ABI decoding — field NAMES are advisory).
    type: "function", name: "getRound",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [
      {
        name: "", type: "tuple",
        components: [
          { name: "handNumber", type: "uint64" },
          { name: "currentBet", type: "uint256" },     // round-level high bet
          { name: "minRaise", type: "uint256" },       // minimum raise increment
          { name: "lastAggressor", type: "uint8" },    // 0xFF if none
          { name: "actedBitmap", type: "uint16" },
          { name: "roundComplete", type: "bool" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    // BetSystem.toCall(tableId) uses Table.currentActor internally; no seat arg.
    type: "function", name: "toCall",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  // ── MS-5 K2 commit-reveal MEV protection (AP-06 #12, 2026-05-22 audit). ──
  // Deploy/setup scripts auto-call `setCommitReveal(true)` per production table.
  // When ON, `act` reverts with CommitRevealRequired; agents MUST use the
  // commit→reveal 2-tx flow (poker_commit_action then poker_reveal_action).
  // Default OFF — tests + Faz 1 single-tx path preserved.
  {
    // BetSystem.commitRevealEnabled(tableId) — per-table view toggle.
    type: "function", name: "commitRevealEnabled",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    // BetSystem.setCommitReveal(tableId, enabled) — admin/authorized system.
    type: "function", name: "setCommitReveal",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "enabled", type: "bool" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    // BetSystem.commitHashFor — pure hash helper used by both commitAction and
    // revealAction. Pre-image: (tableId, handNumber, committer, currentBet,
    // action, amount, salt). currentBet is bound at commit time so the same
    // salt cannot be reused after a state-changing reveal.
    type: "function", name: "commitHashFor",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "handNumber", type: "uint64" },
      { name: "committer", type: "address" },
      { name: "currentBet", type: "uint256" },
      { name: "action", type: "uint8" },
      { name: "amount", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "pure",
  },
  {
    // BetSystem.commitAction(tableId, commitHash) — current actor commits.
    type: "function", name: "commitAction",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "commitHash", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    // BetSystem.revealAction(tableId, action, amount, salt) — same committer
    // reveals; hash must match commitHashFor(...) with committed currentBet.
    type: "function", name: "revealAction",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "action", type: "uint8" },
      { name: "amount", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    // BetSystem.expireReveal(tableId) — anyone-callable after commitDeadline;
    // mirrors expireAction semantics (Fold if pending bet, Check otherwise).
    type: "function", name: "expireReveal",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    // BetSystem.pendingCommitter(tableId) view — who has a live commit.
    type: "function", name: "pendingCommitter",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    // 2026-06-22 (Path B build, FIX-5) — BetSystem.pendingCommit(tableId) view:
    // the committed action hash (zero == none pending). A Path-B harness reads
    // this (with minBlock pinning) to run the commit→reveal barrier without
    // out-of-band cast calls.
    type: "function", name: "pendingCommit",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    // BetSystem.commitDeadline(tableId) — reveal-window unix seconds.
    type: "function", name: "commitDeadline",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint64" }],
    stateMutability: "view",
  },
  {
    // BetSystem.actionDeadline(tableId) — bet-round action timeout unix seconds.
    // Set by _postAct; consumed by expireAction. Read by deadline-aware agents
    // to permissionlessly unstick a frozen betting round (F-05 fix 2026-05-25).
    type: "function", name: "actionDeadline",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint64" }],
    stateMutability: "view",
  },
  {
    // BetSystem.expireAction(tableId) — anyone-callable timeout default for the
    // currentActor seat. K9 default: bet pending → Fold, no bet → Check.
    // F-05 fix 2026-05-25: surfaced via MCP so production agents can unstick
    // a dead-actor table without operator/keeper.
    type: "function", name: "expireAction",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// DealSystem.sol — encrypted shuffle pipeline (B3.6 ZK shuffle + B3.7.B joint
// pk audit trail). Mental-poker design: each agent publishes pk_i with
// publishSessionPk; coordinator sums to joint pk = Σ pk_i and seeds the deck
// via initDeal; each agent re-encrypts via the round-specific submitShuffle*
// entrypoints. There is no commit/reveal randomness step — agent-side shuffle
// randomness is bound by the Groth16 proof and the joint-pk pipeline
// supersedes the original RandomnessSystem-based design.
//
// ZK Shuffle Gas milestone (2026-05-21) — the single 418-public-signal
// `submitShuffle` was split into three commitment-chained entrypoints
// (`submitShuffleFirst` / `submitShuffleMid` / `submitShuffleLast`) plus a
// `reportShuffleDAFault` adjudication path. poker_shuffle_prove picks the
// entrypoint by DealSystem.shuffleRound; the caller still just broadcasts the
// returned unsignedTx, so the agent-runner surface is unchanged.
export const PokerDealAbi = [
  // DealSystem.initDeal — seed table deck with joint pk + initial ciphertexts.
  // Called once per hand by the table admin (or first agent) before sequential
  // shuffle proofs start. Subsequent submitShuffle calls chain the deck state.
  {
    type: "function", name: "initDeal",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "pk", type: "uint256[2]" },
      { name: "initialC1", type: "uint256[2][52]" },
      { name: "initialC2", type: "uint256[2][52]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ── ZK Shuffle Gas (2026-05-21) — round-specific shuffle entrypoints. ──
  //
  // The shuffle is a commitment chain: each round's circuit emits a Poseidon
  // deck commitment, and the contract chains rounds with a plain field-element
  // equality (outputCommit[r] == inputCommit[r+1]). No deck is hashed on-chain.
  // poker_shuffle_prove reads DealSystem.shuffleRound + handRoster and selects:
  //   round 0                 -> submitShuffleFirst
  //   0 < round < len-1        -> submitShuffleMid
  //   round == len-1           -> submitShuffleLast
  //
  // DealSystem.submitShuffleFirst — round 0. deck_0 (the initDeal storage deck)
  // is a Groth16 public signal; the circuit emits `outputCommit` (deck_1's
  // Poseidon commitment, the chain head). outputC1/outputC2 = deck_1, emitted
  // in ShuffleDeckEmitted as the data-availability payload for round 1.
  {
    type: "function", name: "submitShuffleFirst",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "outputCommit", type: "uint256" },
      { name: "outputC1", type: "uint256[2][52]" },
      { name: "outputC2", type: "uint256[2][52]" },
      { name: "pA", type: "uint256[2]" },
      { name: "pB", type: "uint256[2][2]" },
      { name: "pC", type: "uint256[2]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // DealSystem.submitShuffleMid — rounds 1..len-2. Both decks are private
  // circuit witnesses; only commitments are public (4-signal circuit, ~240k
  // verify gas — the milestone's core win). `inputCommit` must equal the
  // running on-chain deckCommitment; `outputCommit` advances the chain.
  {
    type: "function", name: "submitShuffleMid",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "inputCommit", type: "uint256" },
      { name: "outputCommit", type: "uint256" },
      { name: "outputC1", type: "uint256[2][52]" },
      { name: "outputC2", type: "uint256[2][52]" },
      { name: "pA", type: "uint256[2]" },
      { name: "pB", type: "uint256[2][2]" },
      { name: "pC", type: "uint256[2]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // DealSystem.submitShuffleLast — round len-1. The output deck (deck_N) IS a
  // Groth16 public signal, so the deck DealSystem writes to storage for
  // DecryptSystem is verifier-bound. `inputCommit` must equal the on-chain
  // deckCommitment. No ShuffleDeckEmitted — deck_N lives on-chain.
  {
    type: "function", name: "submitShuffleLast",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "inputCommit", type: "uint256" },
      { name: "outputC1", type: "uint256[2][52]" },
      { name: "outputC2", type: "uint256[2][52]" },
      { name: "pA", type: "uint256[2]" },
      { name: "pB", type: "uint256[2][2]" },
      { name: "pC", type: "uint256[2]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // DealSystem.reportShuffleDAFault — DA-griefing adjudication. A first/mid
  // round can submit a valid proof yet emit (in ShuffleDeckEmitted) a deck
  // whose bytes disagree with the `outputCommit` it proved, freezing the next
  // shuffler. The reporter supplies that emitted deck (pinned on-chain by
  // keccak256 == lastEmittedDeckHash) + a `deck_commit` proof; if the proven
  // commitment disagrees with the chain commitment the EMITTER is slashed
  // instead of the innocent stuck shuffler. Built by poker_report_shuffle_da_fault.
  {
    type: "function", name: "reportShuffleDAFault",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "claimedCommit", type: "uint256" },
      { name: "disputedC1", type: "uint256[2][52]" },
      { name: "disputedC2", type: "uint256[2][52]" },
      { name: "pA", type: "uint256[2]" },
      { name: "pB", type: "uint256[2][2]" },
      { name: "pC", type: "uint256[2]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // Views — mostly used by poker_shuffle_prove to read the current deck state.
  {
    type: "function", name: "isInitialized",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    // F-03 — keccak256(abi.encode(initialC1, initialC2)) committed at initDeal.
    type: "function", name: "deckCommitmentOf",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "deckPk",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [
      { name: "x", type: "uint256" },
      { name: "y", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function", name: "cardCiphertext",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "cardIdx", type: "uint8" },
    ],
    outputs: [
      { name: "c1x", type: "uint256" },
      { name: "c1y", type: "uint256" },
      { name: "c2x", type: "uint256" },
      { name: "c2y", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function", name: "deckSnapshot",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [
      { name: "pk", type: "uint256[2]" },
      { name: "c1", type: "uint256[2][52]" },
      { name: "c2", type: "uint256[2][52]" },
      { name: "initialized", type: "bool" },
      { name: "round", type: "uint32" },
    ],
    stateMutability: "view",
  },
  {
    type: "function", name: "shuffleRound",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint32" }],
    stateMutability: "view",
  },
  // ZK Shuffle Gas — the running B-pattern chain commitment (Poseidon
  // outputCommit of the latest accepted round; 0 before round 0). A mid/last
  // shuffler reads this to set its `inputCommit`; poker_shuffle_prove also
  // cross-checks it against the deck it was handed to detect DA griefing.
  {
    type: "function", name: "deckCommitment",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  // ZK Shuffle Gas — keccak256 of the deck the latest first/mid round emitted
  // as its data-availability payload. poker_report_shuffle_da_fault pins the
  // disputed deck against this before adjudicating.
  {
    type: "function", name: "lastEmittedDeckHash",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  // B3.7.B: per-hand session pk audit trail (real mental poker — joint pk =
  // Σ pk_i, not single-admin). Each agent calls publishSessionPk before
  // initDeal; coordinator reads getSessionPks, sums them off-chain, feeds the
  // result into initDeal. Other agents re-sum and verify against deckPk
  // before submitting their shuffle round (trust-but-verify, no on-chain
  // BabyJub aggregation).
  {
    type: "function", name: "publishSessionPk",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "pkX", type: "uint256" },
      { name: "pkY", type: "uint256" },
      // C-1 (deep audit 2026-06-29) — Schnorr proof-of-possession (R, s).
      { name: "Rx", type: "uint256" },
      { name: "Ry", type: "uint256" },
      { name: "s", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "getSessionPks",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [
      {
        name: "", type: "tuple[]",
        components: [
          { name: "agent", type: "address" },
          { name: "pkX",   type: "uint256" },
          { name: "pkY",   type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function", name: "sessionPkCount",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "hasPublishedSessionPk",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "agent", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  // G14 — DealSystem snapshots active seat roster at initDeal time. After
  // initDeal, this is the authoritative list for jointPk / shuffle order /
  // decrypt classification. Off-chain joint pk recompute, community card
  // index calculations, and shuffle authorization MUST filter by this set
  // (not by TableSystem.occupiedSeats which still includes eliminated seats).
  {
    type: "function", name: "handRoster",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint8[]" }],
    stateMutability: "view",
  },
  // ZK Shuffle Gas — data-availability payload. The encrypted deck a first/mid
  // round produced, emitted so the next shuffler can build its proof
  // (intermediate decks are never stored on-chain). poker_shuffle_prove reads
  // this for round >= 1 input; `producingRound` is the round that output it.
  {
    type: "event", name: "ShuffleDeckEmitted",
    inputs: [
      { name: "tableId", type: "bytes32", indexed: true },
      { name: "producingRound", type: "uint32", indexed: true },
      { name: "c1", type: "uint256[2][52]", indexed: false },
      { name: "c2", type: "uint256[2][52]", indexed: false },
    ],
  },
  // Emitted by every accepted shuffle round (first/mid/last). `round` is the
  // post-increment round counter — equals the count of accepted rounds.
  {
    type: "event", name: "ShuffleAccepted",
    inputs: [
      { name: "tableId", type: "bytes32", indexed: true },
      { name: "agent", type: "address", indexed: true },
      { name: "round", type: "uint32", indexed: true },
    ],
  },
  // ZK Shuffle Gas — emitted when reportShuffleDAFault proves a round emitted
  // a deck inconsistent with the commitment it proved.
  {
    type: "event", name: "ShuffleDAFault",
    inputs: [
      { name: "tableId", type: "bytes32", indexed: true },
      { name: "offenderSeat", type: "uint8", indexed: true },
      { name: "round", type: "uint32", indexed: false },
    ],
  },
  {
    // DealSystem.shuffleDeadline(tableId) — current round's shuffle timeout
    // unix seconds. Returns 0 when not armed (deal not initialized, shuffle
    // complete, or already consumed). F-05 fix 2026-05-25 — surfaced for
    // deadline-aware agents and the agent-runner state-machine probe.
    type: "function", name: "shuffleDeadline",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint64" }],
    stateMutability: "view",
  },
  {
    // DealSystem.expireShuffle(tableId) — anyone-callable timeout for a
    // missed shuffle round. Slashes the boycotting seat (-10 reputation,
    // 3rd consecutive offense → -50 + elimination) and voids the hand,
    // refunding the honest seats. Caller need not be the stuck shuffler;
    // any agent or keeper can unstick a frozen table. F-05 fix 2026-05-25.
    type: "function", name: "expireShuffle",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export const PokerHandFlowRouterAbi = [
  {
    type: "function", name: "startHandAndInitRound",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [
      { name: "handNumber", type: "uint64" },
      { name: "dealerButton", type: "uint8" },
      { name: "sbSeat", type: "uint8" },
      { name: "bbSeat", type: "uint8" },
      { name: "firstActor", type: "uint8" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "advancePhaseAndInitRound",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "newPhase", type: "uint8" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "resetCryptoForNextHand",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// DecryptSystem.sol — partial-decryption share collector. B3.7.A introduced
// per-card threshold (hole = N-1, community = N, burn/unused = 0) and a
// hole-owner submission block. B3.7.C wires the agent-side path: each
// non-owner publishes d_i = sk_i · c1 + ZK proof, then anyone can recover
// plaintext m = c2 - Σ d_i once threshold is met (off-chain BabyJub sum).
export const PokerDecryptAbi = [
  {
    // Public signal layout for the verifier (6): pk[2] + c1[2] + d[2].
    // The contract reads c1/c2 from DealSystem.cardCiphertext and reconstructs
    // sig[] internally — agents only send (contributorPk, d, pA, pB, pC).
    type: "function", name: "submitPartialDecryptShare",
    inputs: [
      { name: "tableId",        type: "bytes32" },
      { name: "cardIdx",        type: "uint8" },
      { name: "contributorPk",  type: "uint256[2]" },
      { name: "d",              type: "uint256[2]" },
      { name: "pA",             type: "uint256[2]" },
      { name: "pB",             type: "uint256[2][2]" },
      { name: "pC",             type: "uint256[2]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    // B3.7.E — Hole-owner showdown reveal. Same DLEQ proof shape as
    // submitPartialDecryptShare; only callable while the table is in
    // Phase.Showdown AND msg.sender owns the hole card. Wired to a separate
    // storage slot so the B3.7.A privacy invariant for normal play stays
    // intact.
    type: "function", name: "submitOwnerShareForShowdown",
    inputs: [
      { name: "tableId",        type: "bytes32" },
      { name: "cardIdx",        type: "uint8" },
      { name: "contributorPk",  type: "uint256[2]" },
      { name: "d",              type: "uint256[2]" },
      { name: "pA",             type: "uint256[2]" },
      { name: "pB",             type: "uint256[2][2]" },
      { name: "pC",             type: "uint256[2]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "submitPartialDecryptShares",
    inputs: [
      { name: "tableId",        type: "bytes32" },
      { name: "cardIdxs",       type: "uint8[]" },
      { name: "contributorPk",  type: "uint256[2]" },
      { name: "d",              type: "uint256[2][]" },
      { name: "pA",             type: "uint256[2][]" },
      { name: "pB",             type: "uint256[2][2][]" },
      { name: "pC",             type: "uint256[2][]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "ownerShareSubmitted",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "cardIdx", type: "uint8" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    // DecryptSystem.ownerShareForfeited(tableId, cardIdx) (sol:528-530) — true
    // once expireOwnerShare has forfeited an absent owner's share for the current
    // hand epoch. A forfeited hole card → ShowdownInvoker._buildShowdownInputs
    // treats that SEAT as a forced fold and needs NEITHER the owner share nor the
    // non-owner shares for it. The showdown preflight must read this so a legal
    // forfeit (the liveness rail) does not falsely block invokeShowdown.
    type: "function", name: "ownerShareForfeited",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "cardIdx", type: "uint8" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "getOwnerShare",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "cardIdx", type: "uint8" },
    ],
    outputs: [
      { name: "x", type: "uint256" },
      { name: "y", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function", name: "requiredSharesFor",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "cardIdx", type: "uint8" },
    ],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "holeOwnerOf",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "cardIdx", type: "uint8" },
    ],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    // CardRole enum: 0=Unused, 1=Hole, 2=Burn, 3=Community.
    type: "function", name: "cardRoleOf",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "cardIdx", type: "uint8" },
    ],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "getShare",
    inputs: [
      { name: "tableId",     type: "bytes32" },
      { name: "cardIdx",     type: "uint8" },
      { name: "contributor", type: "address" },
    ],
    outputs: [
      { name: "x", type: "uint256" },
      { name: "y", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function", name: "shareCount",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "cardIdx", type: "uint8" },
    ],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "revealed",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "cardIdx", type: "uint8" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    // DecryptSystem.decryptDeadline(tableId, cardIdx) — current epoch decrypt
    // share deadline for one card. Returns 0 when not armed. F-05 fix 2026-05-25
    // — surfaced so deadline-aware agents can detect a stalled share-collection.
    type: "function", name: "decryptDeadline",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "cardIdx", type: "uint8" },
    ],
    outputs: [{ name: "", type: "uint64" }],
    stateMutability: "view",
  },
  {
    // DecryptSystem.handEpoch(tableId) — bumped each hand reset; public mapping
    // auto-getter. Used together with decryptDeadline so callers can confirm
    // they are reading the current hand's deadline (not a stale epoch).
    type: "function", name: "handEpoch",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint32" }],
    stateMutability: "view",
  },
  {
    // DecryptSystem.expireDecrypt(tableId, cardIdx) — anyone-callable timeout
    // for missing decrypt shares. Slashes boycotters (-10 reputation, 3rd
    // consecutive → -50 + elimination) and voids the hand (refunds run inside
    // TableSystem.voidHand). cardIdx names a hole or community card. F-05 fix
    // 2026-05-25 — surfaced so production agents can unstick a frozen decrypt
    // step without operator/keeper.
    type: "function", name: "expireDecrypt",
    inputs: [
      { name: "tableId", type: "bytes32" },
      { name: "cardIdx", type: "uint8" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// CardRole enum mirror — keep in sync with DecryptSystem.sol.
export const CardRole = {
  Unused: 0,
  Hole: 1,
  Burn: 2,
  Community: 3,
} as const;

// TableSystem.Phase enum mirror — keep in sync with TableSystem.sol.
export const TablePhase = {
  WaitingForPlayers: 0,
  Preflop: 1,
  Flop: 2,
  Turn: 3,
  River: 4,
  Showdown: 5,
  Complete: 6,
} as const;

export const TablePhaseLabel: Record<number, string> = {
  0: "WaitingForPlayers",
  1: "Preflop",
  2: "Flop",
  3: "Turn",
  4: "River",
  5: "Showdown",
  6: "Complete",
};

/**
 * Texas Hold'em deal layout indices for the next betting round, given the
 * current phase + occupied-seat count N. Mirrors `_dealRoleOf` in
 * DecryptSystem.sol — community slots after the hole block start at 2N.
 *
 *   Preflop → Flop  : 2N+1, 2N+2, 2N+3   (3 cards, 1 burn skipped at 2N)
 *   Flop    → Turn  : 2N+5               (1 card, 1 burn skipped at 2N+4)
 *   Turn    → River : 2N+7               (1 card, 1 burn skipped at 2N+6)
 *   River   → Showdown: []               (no community reveal pre-showdown)
 */
export function communityCardIdxsForNextPhase(currentPhase: number, N: number): number[] {
  const holeEnd = 2 * N;
  if (currentPhase === TablePhase.Preflop) return [holeEnd + 1, holeEnd + 2, holeEnd + 3];
  if (currentPhase === TablePhase.Flop)    return [holeEnd + 5];
  if (currentPhase === TablePhase.Turn)    return [holeEnd + 7];
  return [];
}

export function nextPhaseAfter(currentPhase: number): number {
  if (currentPhase === TablePhase.Preflop) return TablePhase.Flop;
  if (currentPhase === TablePhase.Flop)    return TablePhase.Turn;
  if (currentPhase === TablePhase.Turn)    return TablePhase.River;
  if (currentPhase === TablePhase.River)   return TablePhase.Showdown;
  if (currentPhase === TablePhase.Showdown) return TablePhase.Complete;
  return currentPhase;
}

// 2026-05-24 — ShowdownInvoker.invokeShowdown. "Anyone can call" (Showdown
// kontrat satır 87-89: `external` + access-control yok). Üretim agent path'i
// dealer-agent ile çağırır; smoke geçmişinde DEPLOYER_PK yalnızca admin process
// kolaylığıydı, gating kontratta yok.
export const PokerShowdownInvokerAbi = [
  {
    type: "function",
    name: "invokeShowdown",
    stateMutability: "nonpayable",
    inputs: [{ name: "tableId", type: "bytes32" }],
    outputs: [],
  },
] as const;

// Friendly action label → enum mapping for the unified poker_action tool.
// 2026-05-10 — BetSystem.Action enum'i `{Fold,Check,Call,Raise}` (no AllIn).
// All-in artik action degil DURUM: player'in stack'i call edemeyecek kadar
// azsa BetSystem partial-call kabul edip seat.allIn=true set ediyor (standart
// hold'em). Brain "allin" demesin — `call` veya `raise` amount=stack ile yeter.
export const PokerActionEnum = {
  fold: 0,
  check: 1,
  call: 2,
  raise: 3,
} as const;

export type PokerActionLabel = keyof typeof PokerActionEnum;

// ProtocolRegistry (HC#11 versioning). Only the read needed for discovery is
// declared: getActiveRelease() returns the canonical ProtocolRelease, whose
// first address field (tournamentOrchestrator) is the drift-proof scan target —
// reading it from the registry instead of from a possibly-stale env address
// kills the project's most recurrent bug class (stale orchestrator address).
// The full struct must be declared in order so viem can positionally decode it.
export const ProtocolRegistryAbi = [
  {
    type: "function",
    name: "getActiveRelease",
    inputs: [],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "version", type: "uint64" },
          { name: "semver", type: "string" },
          { name: "registeredAt", type: "uint64" },
          { name: "rulesetHash", type: "bytes32" },
          { name: "circuitSetHash", type: "bytes32" },
          { name: "verifierSetHash", type: "bytes32" },
          { name: "bytecodeManifestHash", type: "bytes32" },
          { name: "ceremonyTranscriptHash", type: "bytes32" },
          { name: "tournamentOrchestrator", type: "address" },
          { name: "tableSystem", type: "address" },
          { name: "betSystem", type: "address" },
          { name: "dealSystem", type: "address" },
          { name: "decryptSystem", type: "address" },
          { name: "showdownSystem", type: "address" },
          { name: "showdownInvoker", type: "address" },
          { name: "handFlowRouter", type: "address" },
          { name: "cardPointLookup", type: "address" },
          { name: "shuffleFirstVerifier", type: "address" },
          { name: "shuffleMidVerifier", type: "address" },
          { name: "shuffleLastVerifier", type: "address" },
          { name: "deckCommitVerifier", type: "address" },
          { name: "decryptVerifier", type: "address" },
          { name: "feePolicy", type: "address" },
          { name: "rulesetRegistry", type: "address" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;
