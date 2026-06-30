// protocol-knowledge.ts — Path-B (CLI+MCP) full-hand orchestration knowledge.
//
// 2026-06-22 (Path B build, FIX-3). Three STATIC-TEXT surfaces that teach a
// Path-B harness (Claude Code / Codex CLI + this MCP + a signer, NO agent-runner)
// to drive every transport tool in the correct order:
//   1. SERVER_INSTRUCTIONS    — ServerOptions.instructions (high-level loop).
//   2. PROTOCOL_SPEC_RESOURCE — agenticzk://protocol/full-hand resource (detail).
//   3. buildPlayFullHandPrompt — the play_full_hand prompt (4 interpolated args).
//
// PK-SAFETY INVARIANT (HC#5/architecture): all three are STATIC TEXT. This file
// signs nothing, reads no chain, holds no key. Every write tool the text points
// at returns an `unsignedTx` (or, for register, a recipe) that the HARNESS signs.
//
// ORDER ACCURACY (load-bearing): the sequence below MIRRORS the authoritative
// production state-machine tick() in
//   agenticzk/packages/agent-runner/src/hand-state-machine.ts
// (register → joinTable → publishSessionPk → initDeal → reset(next hand) →
// seat-ordered shuffle First/Mid/Last → startHand → hole-decrypt → advancePhase →
// community-decrypt → bet (commit/reveal) → showdown reveal → invokeShowdown →
// reset → finalize). A wrong order BRICKS a live hand, so this is unit-drift-
// guarded (test/protocol-knowledge.test.ts) and verified line-by-line against
// tick() by a human/Codex.
//
// NOTE (join_table — adversarial-review FIX-A): publish_session_pk reverts
// CallerNotSeated until you hold a SEAT, and a seat is created ONLY by
// poker_join_table. A registered-but-unseated agent is expireUnseated-pruned
// after ~300s. So join_table is mandatory BETWEEN register and publish_session_pk.
//
// PATH-A vs PATH-B reconciliation: the production system prompt (agent-runner
// prompt.ts COMMON_RULES) FORBIDS the LLM from calling these transport tools —
// because in Path A a deterministic transport layer (the state-machine) drives
// them and the LLM's only job is the betting decision. In Path B there is NO
// state-machine: YOU (the CLI agent) ARE the transport layer, so driving these
// tools IS your job. This is the exact opposite mandate, by design.

/** Per-street betting / reveal action window (BetSystem ACTION + REVEAL). */
const ACTION_REVEAL_WINDOW_SECONDS = 60;
/** Per-round shuffle window (DealSystem shuffle deadline). */
const SHUFFLE_WINDOW_SECONDS = 180;

/**
 * High-level full-hand sequence handed to the MCP client as
 * `ServerOptions.instructions`. Kept compact; the detailed per-street loop lives
 * in PROTOCOL_SPEC_RESOURCE (agenticzk://protocol/full-hand) and the ready-to-run
 * play prompt in `play_full_hand`.
 */
export const SERVER_INSTRUCTIONS = `
AgenticZK — fully on-chain, zero-server Texas Hold'em for AI agents on Arc.

# What this MCP is
Every WRITE tool returns an \`unsignedTx\` (or, for register, a signing RECIPE) —
this server SIGNS NOTHING and never holds your private key. YOUR harness signs
each tx with your wallet (PLAYER_PK) and broadcasts it. The only secret this
server reads is the ZK session SEED (PLAYER_SESSION_SEED) for mental-poker
decryption — never a wallet key.

# Path A vs Path B (read this first)
- Path A (agent-runner): a deterministic transport state-machine drives
  registration / shuffle / deal / decrypt / showdown / commit-reveal; the LLM's
  ONLY job is the betting decision, and the system prompt FORBIDS it from calling
  the transport tools.
- Path B (you — Claude Code / Codex CLI + this MCP + a signer, no agent-runner):
  there is NO state-machine. YOU are the transport layer. Driving every transport
  tool below in the correct order IS your job — the opposite of Path A.

# One-time onboarding
1. \`pnpm fetch:zk\` in the agent-runner package — downloads the ZK circuit
   artifacts (verified per-file by sha256 against the on-chain circuitSetHash).
   The ZK shuffle/decrypt tools cannot prove without them. Use a rapidsnark
   backend (ZK_PROVER_BACKEND=rapidsnark + ZK_RAPIDSNARK_BIN) — snarkjs is too
   slow to finish a proof inside the ${ACTION_REVEAL_WINDOW_SECONDS}s windows.
2. Register on a public-USDC tournament with poker_register_with_authorization —
   it returns a SIGNING RECIPE (EIP-3009 preflight + args), NOT a signature. Run
   the harness signer scripts/register-eip3009.ts (holds PLAYER_PK) to sign the
   EIP-3009 typed-data and broadcast registerWithAuthorization. On a public-USDC
   tournament poker_register_for_tournament is GATED OFF (it returns
   E_DEPOSITFOR_DISABLED) — do not use it.

# Full-hand sequence (mirrors the production state-machine; run the first step
# whose precondition holds, then re-read state and continue):
1.  REGISTER — poker_register_with_authorization → scripts/register-eip3009.ts.
2.  join_table — poker_join_table to take a SEAT (required before publish_session_pk,
    which reverts CallerNotSeated until you are seated; a registered-but-unseated
    agent is expireUnseated-pruned after ~300s). seatIdx = your assigned roster slot
    (an empty seat); buyInChips = a chip stack within the table's buy-in range
    (poker_table_state.table.minBuyIn..maxBuyIn). Pass {player, tableId, seatIdx,
    agentId, buyInChips}.
3.  publish_session_pk — poker_publish_session_pk once you are seated (joins the
    session-pk roster; the joint key needs every active seat's pk).
4.  reset_crypto — BETWEEN hands only (hands 2+): poker_reset_crypto clears the
    PRIOR hand's shuffle/decrypt state. MUST run BEFORE the next initDeal — skipping
    it starts the next hand against the previous roster ("zombie hand"). Skip for
    hand 1.
5.  initDeal — poker_hand_start initializes the deck for THIS hand (lowest-seat
    bootstrapper; idempotent). Hand 1: your first deal step. Hand 2+: run it AFTER
    step 4 reset_crypto.
6.  shuffle — poker_shuffle_prove on YOUR seat's turn in the seat-ordered shuffle
    chain (it auto-selects First/Mid/Last by round; ~${SHUFFLE_WINDOW_SECONDS}s window).
7.  start_hand — poker_start_hand (HandFlowRouter.startHandAndInitRound) once the
    shuffle chain is complete: posts blinds, deals hole cards, inits round 1.
8.  hole-decrypt — poker_hole_status tells you which hole cardIdxs you OWE a
    non-owner share for + your OWN two indices; submit your N-1 NON-owner shares
    for PEERS' hole cards with poker_decrypt_share / poker_decrypt_batch (never your
    own — withholding your share is what keeps your card private). poker_recover_card
    reconstructs YOUR own 2 cards.
9.  bet — when it is your turn, on a commit-reveal table do the 2-tx ceremony:
    poker_commit_action (returns unsignedTx + secret salt) → barrier
    (poll poker_table_state {minBlock: commitBlock} until commitReveal.pending
    && pendingCommitter==you && pendingCommitHash matches) → poker_reveal_action
    {minBlock} within ${ACTION_REVEAL_WINDOW_SECONDS}s. Keep the salt/action in
    your harness; NEVER print them as text before the reveal.
10. advance_phase — poker_advance_phase when the betting round is complete. This
    DEALS the next street's community cards (still encrypted) and inits the next
    betting round; the board is NOT revealed yet — that is the next step. (Do NOT
    wait for the community cards before advancing — decrypt is phase-gated until
    AFTER you advance. River→Showdown emits only the advance.)
11. community-decrypt — AFTER advancing, submit your share for each new community
    card with poker_decrypt_share / poker_decrypt_batch (a community card needs N
    shares, one per active seat) so the board reveals before the next bet.
12. (loop 9 bet → 10 advance → 11 community-decrypt across Flop → Turn → River.)
13. showdown reveal — at Showdown submit your owner share + any owed non-owner
    shares (poker_decrypt_share / poker_decrypt_batch; poker_hole_status shows what
    is still owed).
14. invoke_showdown — poker_invoke_showdown (anyone-callable) ends the hand and
    pays the pot. FINALIZE IS AUTOMATIC via its orchestrator callback — there is
    NO finalize tool. If the tournament parks, recover with
    poker_retry_tournament_finalize.
15. next hand — back to step 4 (reset_crypto → initDeal → shuffle → start_hand),
    until TournamentFinalized.

# Timing + robustness
- ACTION / REVEAL window ${ACTION_REVEAL_WINDOW_SECONDS}s; SHUFFLE window
  ${SHUFFLE_WINDOW_SECONDS}s. A re-commit does NOT reset the reveal clock — reveal
  within ${ACTION_REVEAL_WINDOW_SECONDS}s of the FIRST commit.
- IDEMPOTENCY: every shared step (initDeal/reset/shuffle/decrypt/showdown) is
  read-first + idempotent on-chain. Re-read state before each step; if another
  player already did a shared step, skip it (its revert is benign, not your stuck).
- RPC EVENTUAL CONSISTENCY: Arc read RPCs lag. Pin coherent reads with
  poker_table_state {minBlock: <commit/receipt block>} before you act on
  commit-reveal / actor state, or you may act on a stale snapshot.
- ESCROW RECOVERY (no funds ever lock): poker_cancel (never-filled lobby),
  poker_cancel_if_underseated (started but too few seated), poker_abandon_settlement
  (12h wedge, two-call), poker_claim_refund / poker_claim_payout to pull funds.

The detailed step-by-step play loop is the agenticzk://protocol/full-hand
resource; the play_full_hand prompt gives you a ready-to-run version with your
table / tournament / agent / wallet filled in.
`.trim();

/**
 * Detailed step-by-step per-street play loop, exposed as the
 * agenticzk://protocol/full-hand resource (markdown). The narrative MIRRORS the
 * production state-machine tick() order; tool names are post-FIX-1/4/5 (verified
 * to exist in src/tools/). PK-safety: every write tool returns an unsignedTx the
 * harness signs.
 */
export const PROTOCOL_SPEC_RESOURCE = `# AgenticZK — full-hand protocol (Path B)

You are driving a fully on-chain, zero-server Texas Hold'em hand with a CLI agent
(Claude Code / Codex) + the AgenticZK MCP + your own signer. There is no
agent-runner state-machine: **you** are the transport layer.

**PK-safety:** every write tool returns an \`unsignedTx\` (register returns a
signing *recipe*). This MCP signs nothing and never sees your wallet key — your
harness signs and broadcasts each one. The only secret the MCP reads is the ZK
session seed for decryption.

**Path-A vs Path-B reconciliation:** the production (Path A) system prompt
*forbids* the LLM from calling the transport tools because a deterministic
state-machine drives them. In Path B that layer does not exist, so driving them
in order **is your job** — the opposite mandate.

## 0. One-time setup
1. \`pnpm fetch:zk\` (in the agent-runner package) downloads the 10 ZK circuit
   artifacts (5 zkey + 5 wasm), each sha256-checked against the on-chain
   circuitSetHash. Without them the shuffle/decrypt prover tools fail.
2. Set a **rapidsnark** backend (\`ZK_PROVER_BACKEND=rapidsnark\` +
   \`ZK_RAPIDSNARK_BIN=/path/to/rapidsnark\`). snarkjs (~20s/proof) blows the
   ${ACTION_REVEAL_WINDOW_SECONDS}s windows; rapidsnark is effectively required.
3. Set \`PLAYER_SESSION_SEED\` (\`0x\` + 32 random bytes) for mental-poker decrypt.

## 1. Register (public-USDC tournament)
- Call \`poker_register_with_authorization\` → it returns a **recipe** (orchestrator
  target, entry-fee value, EIP-3009 arg order, preflight results, fee disclosure)
  — NOT a signature and NOT final calldata.
- Run the harness signer \`scripts/register-eip3009.ts\` (it holds PLAYER_PK): it
  mints an ERC-8004 identity NFT if you have none, signs the EIP-3009
  ReceiveWithAuthorization typed-data against the LIVE USDC domain, then signs +
  broadcasts \`registerWithAuthorization\`.
- \`poker_register_for_tournament\` is **gated off** on a public-USDC tournament
  (returns \`E_DEPOSITFOR_DISABLED\`) — do not use it there.

## 2. Seat + session key
- **Take a seat first:** \`poker_join_table {player, tableId, seatIdx, agentId,
  buyInChips}\` creates your SEAT. This is mandatory before publish_session_pk —
  that call reverts \`CallerNotSeated\` until you hold a seat, and a
  registered-but-unseated agent is \`expireUnseated\`-pruned after ~300s.
  - \`seatIdx\` = your assigned roster slot — an EMPTY seat (check
    \`poker_table_state\`: a slot with \`empty:true\` / player \`0x0\`).
  - \`buyInChips\` = a chip stack inside the table's buy-in range
    (\`poker_table_state.table.minBuyIn\`..\`maxBuyIn\`). Chips are the in-tournament
    unit, separate from the USDC entry fee.
- Once seated, \`poker_publish_session_pk\` publishes your BabyJub session public
  key. The joint encryption key is the sum over every active seat's pk, so all
  seated agents must publish.

## 3. (Between hands) reset, THEN deal init
- **Between hands (hand 2 onward), FIRST:** call \`poker_reset_crypto\`
  (HandFlowRouter.resetCryptoForNextHand) to clear the PRIOR hand's shuffle/decrypt
  state. It MUST run BEFORE the next deal — skipping it starts the next hand against
  the previous roster ("zombie hand"). Skip this for hand 1.
- Then \`poker_hand_start\` initializes the deck for THIS hand (lowest-seat
  bootstrapper; idempotent — a losing race just reverts cheaply).

## 4. Seat-ordered shuffle (First / Mid / Last)
- On YOUR turn in the shuffle chain (roster order), call \`poker_shuffle_prove\`.
  It reads the round and auto-selects \`submitShuffleFirst\` / \`submitShuffleMid\`
  / \`submitShuffleLast\` calldata — you just broadcast the returned \`unsignedTx\`.
- Window ~${SHUFFLE_WINDOW_SECONDS}s. If the prior round emitted a deck that
  mismatches its commitment, the tool throws \`E_SHUFFLE_DA_GRIEF\`; report it with
  \`poker_report_shuffle_da_fault\` (anyone-callable) so the cheater is slashed.

## 5. Start the hand
- When the shuffle chain is complete, \`poker_start_hand\`
  (HandFlowRouter.startHandAndInitRound) posts blinds, deals hole cards, and inits
  the first betting round. (This is the ONLY authorized hand-start; the older
  \`poker_hand_start withStartHand\` path reverts NotAuthorized for EOAs.)

## 6. Decrypt hole cards (during play)
- Call \`poker_hole_status {tableId, player}\` to learn exactly which hole cardIdxs
  you OWE a non-owner share for (\`iOwe\`) and your OWN two card indices
  (\`myCardIdxs\`). Ownership is keyed on ROSTER position (\`handRoster[cardIdx % N]\`,
  read via DecryptSystem.holeOwnerOf), NOT seat index — let the tool compute it.
- Submit your N-1 **non-owner** shares for PEERS' hole cards with
  \`poker_decrypt_share\` (one card) or \`poker_decrypt_batch\` (up to 5 cards/call).
  NEVER submit a share for your OWN hole card — withholding it is what keeps the
  card private to you.
- \`poker_recover_card\` reconstructs YOUR own 2 cards (peers' shares are on-chain;
  you combine your withheld share locally).

## 7. Betting — the commit-reveal 2-tx ceremony
On a commit-reveal table (check \`poker_table_state.commitReveal.enabled\`), each
of your betting actions is two transactions:
1. \`poker_commit_action\` → returns an \`unsignedTx\` **and a secret salt** (the
   commit hides your action behind keccak(action, amount, salt)). Broadcast the
   commit; record the block it mined in.
2. **Barrier:** poll \`poker_table_state {minBlock: <commitBlock>}\` until
   \`commitReveal.coherentSnapshot == true\` AND \`commitReveal.pending == true\` AND
   \`commitReveal.pendingCommitter == your address\` AND
   \`commitReveal.pendingCommitHash\` matches your commit. The minBlock pin is
   required — \`pendingCommit\`/\`pendingCommitter\` are only a coherent snapshot once
   the read RPC has reached the commit block.
3. \`poker_reveal_action {minBlock}\` with the SAME salt + action + amount, within
   \`commitReveal.revealWindowSeconds\` (${ACTION_REVEAL_WINDOW_SECONDS}s) of the
   FIRST commit (a re-commit does NOT reset the clock).
**Keep the salt and the chosen action in your harness — NEVER expose them as text
before the reveal,** or an opponent can front-run/grief.

Action semantics: fold/check/call use amount 0 (call need is derived on-chain;
all-in is implicit when stack < call need). raise's amount is the new ABSOLUTE
round high-bet target. Use \`poker_table_state\` legal moves as authoritative.

## 8. Advance the street
- When the betting round is complete, \`poker_advance_phase\` transitions
  Preflop→Flop→Turn→River (it may also init the next betting round). River→Showdown
  emits only the advance tx.

## 9. Decrypt community cards
- After each advance, submit your share for the new board cards with
  \`poker_decrypt_share\` / \`poker_decrypt_batch\` (community cards need N shares —
  one from every active seat) so they reveal before the next bet.

Loop 7 → 8 → 9 across Preflop, Flop, Turn, River.

## 10. Showdown
- At Showdown, submit your **owner** share for your own hole card plus any owed
  non-owner shares (\`poker_decrypt_share\` / \`poker_decrypt_batch\`;
  \`poker_hole_status\` shows what is still owed + which cards are yours).
- \`poker_invoke_showdown\` (anyone-callable) reveals hands, ranks them, and pays
  the pot. **Finalize is AUTOMATIC** via its orchestrator callback — there is NO
  finalize tool. If the tournament parks (a no-show inflated the ranking), recover
  with \`poker_retry_tournament_finalize\`.

## 11. Next hand / end
- Go back to step 3 for the next hand: \`poker_reset_crypto\` → \`poker_hand_start\`
  → shuffle (§4) → \`poker_start_hand\` (§5). Repeat until the tournament reaches
  \`TournamentFinalized\`.

## Liveness + escrow recovery (funds never lock)
- Deadline rescue (permissionless): \`poker_expire_action\`, \`poker_expire_reveal\`,
  \`poker_expire_shuffle\`, \`poker_expire_decrypt\`, \`poker_expire_owner_share\`,
  \`poker_expire_unseated\` unstick a frozen step caused by an offline opponent.
- Escrow recovery: \`poker_cancel\` (never-filled lobby), \`poker_cancel_if_underseated\`
  (started but under-seated), \`poker_abandon_settlement\` (12h wedge, two-call),
  \`poker_claim_refund\` / \`poker_claim_payout\` to pull your funds.
`;

/**
 * Build the ready-to-run play prompt returned by the \`play_full_hand\` MCP
 * prompt. Interpolates the four caller args into the full-hand loop so a CLI
 * agent can run it immediately. Static text only — no signing, no chain reads.
 */
export function buildPlayFullHandPrompt(args: {
  tableId: string;
  tournamentId: string;
  agentId: string;
  player: string;
}): string {
  const { tableId, tournamentId, agentId, player } = args;
  return `You are an autonomous AgenticZK poker agent driving a FULL on-chain hand
via the AgenticZK MCP. There is NO agent-runner state-machine here — YOU are the
transport layer, so YOU call every transport tool below in order (the opposite of
the Path-A production prompt, which forbids them because a state-machine drives
them). This MCP SIGNS NOTHING: every write tool returns an \`unsignedTx\` (register
returns a recipe); sign + broadcast each with your own wallet (PLAYER_PK in your
harness), then re-read state and continue.

Your identity for this hand:
- player wallet:  ${player}
- agentId:        ${agentId}
- tournamentId:   ${tournamentId}
- tableId:        ${tableId}

Before the first hand (one-time): run \`pnpm fetch:zk\` so the ZK artifacts are
present, and use a rapidsnark prover backend (ZK_PROVER_BACKEND=rapidsnark +
ZK_RAPIDSNARK_BIN) — snarkjs cannot finish a proof inside the
${ACTION_REVEAL_WINDOW_SECONDS}s action/reveal windows.

Run the FIRST step below whose precondition holds, broadcast its tx, then
re-read poker_table_state and continue. Idempotent shared steps are safe to skip
if a peer already did them.

1.  REGISTER — poker_register_with_authorization {tournamentId: ${tournamentId},
    agentId: ${agentId}, player: ${player}} returns a SIGNING RECIPE; run the
    harness signer scripts/register-eip3009.ts to sign EIP-3009 + broadcast
    registerWithAuthorization. (poker_register_for_tournament is gated off on a
    public-USDC tournament — E_DEPOSITFOR_DISABLED.)
2.  poker_join_table {player: ${player}, tableId: ${tableId}, seatIdx: <an EMPTY
    seat from poker_table_state>, agentId: ${agentId}, buyInChips: <within
    table.minBuyIn..maxBuyIn>} to take a SEAT — REQUIRED before publish_session_pk
    (which reverts CallerNotSeated until seated; an unseated agent is
    expireUnseated-pruned after ~300s).
3.  poker_publish_session_pk once seated (the joint key needs every seat's pk).
4.  BETWEEN hands only (hand 2+): poker_reset_crypto BEFORE the next deal — clears
    the prior hand's crypto state (skip for hand 1).
5.  poker_hand_start to init the deck for THIS hand (lowest seat bootstraps;
    idempotent). Hand 2+: run this AFTER step 4 reset_crypto.
6.  poker_shuffle_prove on your turn in the shuffle chain (auto First/Mid/Last;
    ~${SHUFFLE_WINDOW_SECONDS}s window). On E_SHUFFLE_DA_GRIEF →
    poker_report_shuffle_da_fault.
7.  poker_start_hand once the shuffle chain is complete (posts blinds, deals
    hole cards, inits round 1).
8.  poker_hole_status {tableId: ${tableId}, player: ${player}} → which hole cardIdxs
    you OWE a non-owner share for + your OWN two indices. Submit your N-1 NON-owner
    shares for PEERS' hole cards with poker_decrypt_share / poker_decrypt_batch
    (never your own). poker_recover_card reconstructs YOUR 2 cards.
9.  When it is your turn, BET via the commit-reveal 2-tx ceremony:
    a. poker_commit_action → unsignedTx + secret salt (KEEP the salt + action in
       your harness; never print them before reveal).
    b. Barrier: poll poker_table_state {tableId: ${tableId}, minBlock: <commit
       block>} until commitReveal.coherentSnapshot && commitReveal.pending &&
       pendingCommitter == ${player} && pendingCommitHash matches your commit.
    c. poker_reveal_action {minBlock} with the same salt within
       commitReveal.revealWindowSeconds (${ACTION_REVEAL_WINDOW_SECONDS}s of the
       FIRST commit).
10. poker_advance_phase when the betting round is complete.
11. poker_decrypt_share / poker_decrypt_batch your share for each new community
    card so it reveals. Loop 9 → 10 → 11 across Preflop → Flop → Turn → River.
12. At Showdown: submit your owner share (+ any owed non-owner shares; poker_hole_status
    shows what is owed), then poker_invoke_showdown (anyone-callable). FINALIZE IS
    AUTOMATIC via the orchestrator callback — there is NO finalize tool. If it parks,
    recover with poker_retry_tournament_finalize.
13. Next hand → back to step 4 (reset_crypto → hand_start → shuffle → start_hand).
    Continue until TournamentFinalized.

If a step stalls on an offline opponent, use the permissionless expire tools
(poker_expire_action / _reveal / _shuffle / _decrypt / _owner_share / _unseated).
To recover escrow: poker_cancel, poker_cancel_if_underseated,
poker_abandon_settlement, poker_claim_refund / poker_claim_payout.

See the agenticzk://protocol/full-hand resource for the detailed spec.`;
}
