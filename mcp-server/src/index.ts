import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
// 2026-06-22 (Path B build, FIX-3) — full-hand orchestration knowledge. Three
// STATIC-TEXT surfaces (server instructions + play_full_hand prompt + protocol
// resource) that teach a Path-B harness to drive every transport tool in order.
// The MCP signs nothing; these are text only.
import {
  SERVER_INSTRUCTIONS,
  PROTOCOL_SPEC_RESOURCE,
  buildPlayFullHandPrompt,
} from "./protocol-knowledge.js";
import { agentRegisterHandler } from "./tools/agent_register.js";
import { agentReputationHandler } from "./tools/agent_reputation.js";
import { agentValidateHandler } from "./tools/agent_validate.js";
import { jobCreateHandler } from "./tools/job_create.js";
import { jobSetBudgetHandler, jobFundEscrowHandler } from "./tools/job_fund.js";
import { jobSubmitHandler } from "./tools/job_submit.js";
import { jobCompleteHandler } from "./tools/job_complete.js";
import { jobRejectHandler } from "./tools/job_reject.js";
import { jobClaimRefundHandler } from "./tools/job_claim_refund.js";
import { jobStatusHandler } from "./tools/job_status.js";
import { balanceHandler } from "./tools/balance.js";

// AgenticZK tools (M6.B 2026-04-26).
import { pokerCreateTournamentHandler } from "./tools/poker_create_tournament.js";
import { pokerRegisterForTournamentHandler } from "./tools/poker_register_for_tournament.js";
import { pokerRegisterWithAuthorizationHandler } from "./tools/poker_register_with_authorization.js";
import { pokerStartTournamentHandler } from "./tools/poker_start_tournament.js";
// 2026-06-22 (Path B build, FIX-4) — router + escrow-recovery wrappers. The dead
// poker_finalize_tournament tool (it encoded the REMOVED finalize fn) is deleted.
import { pokerStartHandHandler } from "./tools/poker_start_hand.js";
import { pokerResetCryptoHandler } from "./tools/poker_reset_crypto.js";
import { pokerCancelHandler } from "./tools/poker_cancel.js";
import { pokerCancelIfUnderseatedHandler } from "./tools/poker_cancel_if_underseated.js";
import { pokerAbandonSettlementHandler } from "./tools/poker_abandon_settlement.js";
import { pokerJoinTableHandler } from "./tools/poker_join_table.js";
import { pokerActionHandler } from "./tools/poker_action.js";
import { pokerTableStateHandler } from "./tools/poker_table_state.js";
import { pokerTournamentStateHandler } from "./tools/poker_tournament_state.js";
import { pokerDiscoverOpenTournamentsHandler } from "./tools/poker_discover_open_tournaments.js";
import { pokerShuffleProveHandler } from "./tools/poker_shuffle_prove.js";
import { pokerReportShuffleDaFaultHandler } from "./tools/poker_report_shuffle_da_fault.js";
import { pokerPublishSessionPkHandler } from "./tools/poker_publish_session_pk.js";
import { pokerHandStartHandler } from "./tools/poker_hand_start.js";
import { pokerDecryptShareHandler } from "./tools/poker_decrypt_share.js";
import { pokerDecryptBatchHandler } from "./tools/poker_decrypt_batch.js";
import { pokerRecoverCardHandler } from "./tools/poker_recover_card.js";
import { pokerRoundStatusHandler } from "./tools/poker_round_status.js";
import { pokerHoleStatusHandler } from "./tools/poker_hole_status.js";
import { pokerAdvancePhaseHandler } from "./tools/poker_advance_phase.js";
// 2026-05-24 — Codex mainnet readiness item 3 B-2: production agent path
// dealer-agent ile showdown invoke edebilsin. Kontrat "Anyone can call".
import { pokerInvokeShowdownHandler } from "./tools/poker_invoke_showdown.js";
// 2026-05-22 AP-06 #12 — commit-reveal 2-tx flow (MS-5 K2 MEV protection).
import { pokerCommitActionHandler } from "./tools/poker_commit_action.js";
import { pokerRevealActionHandler } from "./tools/poker_reveal_action.js";
// 2026-05-25 F-05 (Codex end-user audit) — permissionless timeout/liveness tools.
// Production agent / keeper can unstick any frozen step without operator help.
import { pokerExpireActionHandler } from "./tools/poker_expire_action.js";
import { pokerExpireRevealHandler } from "./tools/poker_expire_reveal.js";
import { pokerExpireShuffleHandler } from "./tools/poker_expire_shuffle.js";
import {
  pokerExpireDecryptHandler,
  pokerArmDecryptDeadlineHandler,
} from "./tools/poker_expire_decrypt.js";
// 2026-05-26 Codex mainnet-readiness audit — C-01 / C-02 / C-03 liveness rails.
import { pokerExpireUnseatedHandler } from "./tools/poker_expire_unseated.js";
import {
  pokerArmOwnerShareDeadlineHandler,
  pokerExpireOwnerShareHandler,
} from "./tools/poker_expire_owner_share.js";
import { pokerRetryTournamentFinalizeHandler } from "./tools/poker_retry_tournament_finalize.js";
// 2026-05-11 — P0-4 son kullanici akisi tool'lari (Codex public-readiness audit).
import { pokerClaimPayoutHandler } from "./tools/poker_claim_payout.js";
import { pokerClaimRefundHandler } from "./tools/poker_claim_refund.js";
import { pokerWithdrawPendingDepositHandler } from "./tools/poker_withdraw_pending_deposit.js";

const server = new McpServer(
  {
    name: "agenticzk-mcp",
    // Keep in sync with package.json "version" (single canonical version surface).
    version: "1.0.0",
  },
  // 2026-06-22 (Path B build, FIX-3) — high-level full-hand sequence + Path-A/B
  // reconciliation + PK-safety note, surfaced to the MCP client at handshake.
  { instructions: SERVER_INSTRUCTIONS },
);

// 2026-06-13 (mission-scope teardown, Sahip-approved) — the standalone Circle
// base-kit money-mover tools (send_token / bridge_send / nano_deposit / nano_pay)
// that signed with a wallet PK were REMOVED. AgenticZK's Circle integration is
// contract-side EIP-3009 (the register/payment flow); the standalone money toolkit
// was inherited base-repo cruft and out of poker scope. The MCP is now poker-only:
// every tool returns an UNSIGNED tx the harness signs, so there is NO wallet-PK
// signing surface at all (loadPlayerPk was removed from wallet-env too). The only
// secret the server reads is the ZK session SEED (loadSessionSeed) for mental-poker
// decrypt — never the wallet PK.

// audit 2026-05-22 MC-15/D5 — Startup log eskiden hard-coded "32 tools"
// gösteriyordu ama kodda 36 server.tool() kaydı var (gerçek). Yeni tool
// eklendikçe log drift'i tekrarlanmasın diye sayım runtime'da. `server.tool`
// metodunu wrap edip her kaydı REGISTERED_TOOLS'a yazıyoruz; log connect
// sonrası bu listeyi sayar (aşağıda startup mesajı).
const REGISTERED_TOOLS: string[] = [];
const _origRegister = server.tool.bind(server);
(server as unknown as { tool: typeof _origRegister }).tool = ((
  name: string,
  ...rest: unknown[]
) => {
  REGISTERED_TOOLS.push(name);
  return (_origRegister as unknown as (n: string, ...r: unknown[]) => unknown)(
    name,
    ...rest,
  );
}) as typeof _origRegister;

// ═══════════════════════════════════════════
// ERC-8004: Agent Identity & Reputation
// ═══════════════════════════════════════════

server.tool(
  "agent_register",
  "Register an AI agent on-chain (ERC-8004). Mints an ERC-721 identity NFT. The caller becomes the agent owner.",
  {
    owner: z.string().describe("Owner wallet address (will sign the tx)"),
    metadataURI: z.string().describe("IPFS or HTTP URI pointing to agent metadata JSON"),
  },
  async (args) => agentRegisterHandler(args),
);

server.tool(
  "agent_reputation",
  "Give reputation feedback to an AI agent (ERC-8004). Agent owners cannot rate their own agents.",
  {
    action: z.enum(["give"]).describe("Action: 'give' to submit feedback"),
    agentId: z.string().describe("Agent token ID (from registration)"),
    reviewer: z.string().optional().describe("Reviewer wallet address (must differ from agent owner)"),
    score: z.number().optional().describe("Score (e.g. 0-100). Default: 100"),
    feedbackType: z.number().optional().describe("Feedback type (0=general). Default: 0"),
    tag: z.string().optional().describe("Tag for categorization (e.g. 'reliability'). Default: 'general'"),
    comment: z.string().optional().describe("Free-text comment about agent performance"),
  },
  async (args) => agentReputationHandler(args),
);

server.tool(
  "agent_validate",
  "Request or respond to agent validation (ERC-8004). Validators certify agent capabilities.",
  {
    action: z.enum(["request", "respond", "status"]).describe("Action: request validation, respond to request, or check status"),
    owner: z.string().optional().describe("Agent owner address (for 'request' action)"),
    validator: z.string().optional().describe("Validator address"),
    agentId: z.string().optional().describe("Agent token ID"),
    requestURI: z.string().optional().describe("URI describing what to validate"),
    requestHash: z.string().optional().describe("Request hash (for 'respond' and 'status')"),
    response: z.number().optional().describe("Validation response: 100=passed, 0=failed"),
    responseURI: z.string().optional().describe("URI with validation details"),
    tag: z.string().optional().describe("Validation category tag"),
  },
  async (args) => agentValidateHandler(args),
);

// ═══════════════════════════════════════════
// ERC-8183: Agentic Jobs
// ═══════════════════════════════════════════

server.tool(
  "job_create",
  "Create an agentic job (ERC-8183). Client posts a job, provider does the work, evaluator approves payment.",
  {
    client: z.string().describe("Client wallet (job creator, will sign tx)"),
    provider: z.string().describe("Provider wallet (who will do the work)"),
    evaluator: z.string().optional().describe("Evaluator wallet (defaults to client). Approves deliverables."),
    description: z.string().describe("Human-readable job description"),
    deadlineMinutes: z.number().optional().describe("Job deadline in minutes from now. Default: 1440 (24h). Min: 15, Max: 43200 (30d)."),
  },
  async (args) => jobCreateHandler(args),
);

server.tool(
  "job_set_budget",
  "Set the budget for a job (ERC-8183). Provider specifies how much USDC the job should pay.",
  {
    provider: z.string().describe("Provider wallet (must match job's provider)"),
    jobId: z.string().describe("Job ID (from job_create event)"),
    amountUsdc: z.string().describe("Budget amount in USDC (e.g. '10.00')"),
  },
  async (args) => jobSetBudgetHandler(args),
);

server.tool(
  "job_fund",
  "Fund a job's escrow (ERC-8183). Client deposits USDC into the contract. Returns approve + fund transactions.",
  {
    client: z.string().describe("Client wallet (must match job's client)"),
    jobId: z.string().describe("Job ID"),
  },
  async (args) => jobFundEscrowHandler(args),
);

server.tool(
  "job_submit",
  "Submit a deliverable for a job (ERC-8183). Provider submits a hash of their work.",
  {
    provider: z.string().describe("Provider wallet (must match job's provider)"),
    jobId: z.string().describe("Job ID"),
    deliverable: z.string().describe("Deliverable content or description (will be hashed on-chain)"),
  },
  async (args) => jobSubmitHandler(args),
);

server.tool(
  "job_complete",
  "Approve a job and release payment (ERC-8183). Evaluator confirms the deliverable and USDC flows to provider.",
  {
    evaluator: z.string().describe("Evaluator wallet (must match job's evaluator)"),
    jobId: z.string().describe("Job ID"),
    reason: z.string().optional().describe("Approval reason (will be hashed). Default: 'approved'"),
  },
  async (args) => jobCompleteHandler(args),
);

server.tool(
  "job_reject",
  "Reject a job's deliverable (ERC-8183). Evaluator rejects substandard work. Job transitions to Rejected state and the contract AUTOMATICALLY refunds escrowed USDC to the client (no separate claimRefund call needed). Verified on Arc testnet: reject tx returns escrow to client wallet within the same block.",
  {
    evaluator: z.string().describe("Evaluator wallet (must match job's evaluator)"),
    jobId: z.string().describe("Job ID"),
    reason: z.string().optional().describe("Rejection reason (will be hashed). Default: 'rejected: deliverable does not meet criteria'"),
  },
  async (args) => jobRejectHandler(args),
);

server.tool(
  "job_claim_refund",
  "Reclaim escrowed USDC from an EXPIRED job (ERC-8183). Use only when a job passed its expiredAt deadline and funds are still locked. Bypasses hooks per EIP-8183 spec — guaranteed recovery path after expiry. For Rejected jobs, refund is automatic via job_reject (no need to call this).",
  {
    client: z.string().describe("Client wallet (must match job's client)"),
    jobId: z.string().describe("Job ID (must be in Expired state)"),
  },
  async (args) => jobClaimRefundHandler(args),
);

server.tool(
  "job_status",
  "Check the status of an agentic job (ERC-8183). Returns parties, budget, status, and deadline.",
  {
    jobId: z.string().describe("Job ID to query"),
  },
  async (args) => jobStatusHandler(args),
);

// ═══════════════════════════════════════════
// Read-only balance (no signing — RPC view only)
// ═══════════════════════════════════════════

server.tool(
  "balance",
  "Check USDC and EURC balances for any wallet on Arc Testnet.",
  {
    address: z.string().describe("Wallet address to check"),
  },
  async (args) => balanceHandler(args),
);

// ═══════════════════════════════════════════
// AgenticZK (Texas Hold'em on Arc, M6.B)
// ═══════════════════════════════════════════

server.tool(
  "poker_create_tournament",
  "Create a new AgenticZK tournament. tournamentId is derived from `name` via keccak256. Defaults: entryFee 1 USDC, 50/30/20 payout, +30/+10/0 reputation deltas.",
  {
    admin: z.string().describe("Admin wallet (will sign + organize)"),
    name: z.string().describe("Tournament name; deterministic id = keccak256(utf8(name))"),
    entryFeeUsdc: z.string().optional().describe("Entry fee in USDC (default '1.00')"),
    minPlayers: z.number().optional().describe("Minimum players to start (default 2)"),
    maxPlayers: z.number().optional().describe("Maximum players (default 8, hard cap 9)"),
    payoutBps: z.array(z.number()).optional().describe("Payout distribution in basis points (must sum to 10000). Default [5000,3000,2000]."),
    reputationDelta: z.array(z.number()).optional().describe("Per-rank reputation delta. Default [30,10,0]. Must match payoutBps length."),
  },
  async (args) => pokerCreateTournamentHandler(args),
);

server.tool(
  "poker_register_for_tournament",
  // audit 2026-05-22 D3 — eski description "2 unsigned tx (approve+register)"
  // yanlıştı: handler H2 3-adım flow döndürüyor (transfer+depositFor+register —
  // Arc Bug 1 workaround, [[feedback-h2-register-flow-3-step]]). LLM brain
  // doğru imza sırası için bu sayıyı bilmek zorunda.
  "Register an agent for a tournament. Returns 3 unsigned txs: USDC.transfer (escrow funding) + USDC.depositFor + Orchestrator.register (Arc Bug 1 workaround — H2 3-step flow). Sign in order. FEE DISCLOSURE: a 2% protocol rake (1% house + 1% organizer) is deducted from the prize pool at finalize ONLY — winnings are paid net of it. If a tournament is cancelled/abandoned, your full entry fee is refundable (no rake). Your entry fee is escrowed on register.",
  {
    player: z.string().describe("Player wallet (agent owner). Must equal IdentityRegistry.ownerOf(agentId)."),
    tournamentId: z.string().describe("Tournament id (32-byte hex)"),
    agentId: z.string().describe("ERC-8004 agent token id (numeric string)"),
    entryFeeUsdc: z.string().optional().describe("Entry fee in USDC (must match tournament config; default '1.00')"),
  },
  async (args) => pokerRegisterForTournamentHandler(args),
);

server.tool(
  "poker_register_with_authorization",
  "Register an agent for a PUBLIC-USDC tournament via the atomic EIP-3009 path — the ONLY working register there (poker_register_for_tournament's depositFor reverts on public-USDC and strands your entry fee). PK-SAFE: returns a RECIPE + preflight only (NO signature, NO calldata) and points you at the harness signer scripts/register-eip3009.ts, which holds your key, mints an identity NFT if needed, signs the EIP-3009 typed-data, and broadcasts. Preflight catches wrong-wallet / double-register / wrong-phase / full-lobby before you spend a tx. FEE DISCLOSURE: 2% rake (1% house + 1% organizer) from the prize pool at finalize only; entry fee escrowed on register, fully refundable on cancel/abandon.",
  {
    player: z.string().describe("Player wallet (agent owner). Must equal IdentityRegistry.ownerOf(agentId)."),
    tournamentId: z.string().describe("Tournament id (32-byte hex)"),
    agentId: z.string().describe("ERC-8004 agent token id (numeric string)"),
    entryFeeUsdc: z.string().optional().describe("Entry fee in USDC (informational; the on-chain tournament.entryFee is authoritative; default '1.00')"),
  },
  async (args) => pokerRegisterWithAuthorizationHandler(args),
);

server.tool(
  "poker_start_tournament",
  "Start a tournament (admin only). Phase Registering → Running. minPlayers must be met.",
  {
    admin: z.string().describe("Admin wallet (must match tournament's admin)"),
    tournamentId: z.string().describe("Tournament id"),
  },
  async (args) => pokerStartTournamentHandler(args),
);

// 2026-06-22 (Path B build, FIX-4) — router + escrow-recovery wrappers replace
// the dead poker_finalize_tournament tool (finalize is automatic via the
// invoke_showdown→orchestrator callback; poker_retry_tournament_finalize is the
// recovery rail).
server.tool(
  "poker_start_hand",
  "Start a hand: HandFlowRouter.startHandAndInitRound (posts blinds, deals hole cards, inits the first betting round). The ONLY authorized hand-start (poker_hand_start's withStartHand targets TableSystem.startHand, which reverts NotAuthorized for EOAs). Callable by the dealer seat, or by any seated agent as a fallback after the ~30-block dealer grace window (on the first hand any seated agent may bootstrap); the deck shuffle chain must be complete (isReadyToStartHand). Returns an unsignedTx.",
  {
    tableId: z.string().describe("Table id (32-byte hex)"),
  },
  async (args) => pokerStartHandHandler(args),
);

server.tool(
  "poker_reset_crypto",
  "Reset per-hand crypto state for the next hand: HandFlowRouter.resetCryptoForNextHand. Required between hands (hands 2+) before the next shuffle. Callable by the dealer seat, or by any seated agent as a fallback after the ~30-block dealer grace window. Returns an unsignedTx.",
  {
    tableId: z.string().describe("Table id (32-byte hex)"),
  },
  async (args) => pokerResetCryptoHandler(args),
);

server.tool(
  "poker_cancel",
  "Cancel a tournament that never filled (Registering phase): Orchestrator.cancel — permissionless. Moves every registrant's entry fee to pendingRefund (pull via poker_claim_refund); no rake on cancel. Returns an unsignedTx.",
  {
    tournamentId: z.string().describe("Tournament id (32-byte hex)"),
  },
  async (args) => pokerCancelHandler(args),
);

server.tool(
  "poker_cancel_if_underseated",
  "Rescue a STARTED tournament that cannot progress because too few registrants seated (no-show wedge): Orchestrator.cancelIfUnderseated — permissionless. Refunds escrow to pendingRefund. Returns an unsignedTx.",
  {
    tournamentId: z.string().describe("Tournament id (32-byte hex)"),
  },
  async (args) => pokerCancelIfUnderseatedHandler(args),
);

server.tool(
  "poker_abandon_settlement",
  "Last-resort 12h stall watchdog: Orchestrator.abandonSettlement — permissionless, TWO-CALL ritual (first call arms, re-broadcast after 12h to settle/refund). Use only if a tournament truly wedges; normal finalize is automatic. Returns an unsignedTx.",
  {
    tournamentId: z.string().describe("Tournament id (32-byte hex)"),
  },
  async (args) => pokerAbandonSettlementHandler(args),
);

server.tool(
  "poker_join_table",
  "Take a seat at a poker table. Buy-in is in chips (separate from USDC entry fee — chips are the in-tournament unit).",
  {
    player: z.string().describe("Player wallet"),
    tableId: z.string().describe("Table id (32-byte hex)"),
    seatIdx: z.number().describe("Seat slot 0..8"),
    agentId: z.string().describe("ERC-8004 agent token id (numeric string)"),
    buyInChips: z.string().describe("Initial chip stack (numeric string)"),
  },
  async (args) => pokerJoinTableHandler(args),
);

server.tool(
  "poker_action",
  "Submit a SINGLE-TX betting action (fold/check/call/raise). REJECTED if BetSystem.commitRevealEnabled[tableId] = true — production tables flip that on, then you MUST use poker_commit_action + poker_reveal_action (2-tx MEV-protected path). For raise, amount is the new ABSOLUTE round-level high bet target. fold/check/call → amount must be 0 (contract derives call from RoundState.currentBet - seat.currentBet); call/raise can consume the remaining stack (BetSystem auto-flags seat.allIn).",
  {
    player: z.string().describe("Player wallet (must match the seat's player at TableSystem.currentActor)"),
    tableId: z.string().describe("Table id"),
    action: z.enum(["fold", "check", "call", "raise"]).describe("Action label"),
    amount: z.string().optional().describe("Numeric string. Required (>0) for raise = new ABSOLUTE round high bet target. Must be 0 (or omitted) for fold/check/call."),
  },
  async (args) => pokerActionHandler(args),
);

// MS-5 K2 commit-reveal flow (AP-06 #12 / 2026-05-22 audit). Deploy script
// auto-flips setCommitReveal(true) per production table. Single-tx `act`
// reverts in that mode (CommitRevealRequired) — agents come through here.
server.tool(
  "poker_commit_action",
  "Commit half of the MS-5 K2 commit-reveal MEV-protected betting flow. Computes commitHashFor(tableId, handNumber, player, currentBet, action, amount, salt) off-chain and returns BetSystem.commitAction(tableId, commitHash) as an unsignedTx. Salt is CSPRNG-generated if omitted; SAVE the returned salt + action + amount for the reveal step. Same legality pre-flight as poker_action (E_CANNOT_CHECK / E_RAISE_TOO_SMALL / E_NOT_CURRENT_ACTOR). Reveal must follow within REVEAL_TIMEOUT_BASE = 60 s of the commit landing on-chain or anyone can call expireReveal to default the missed reveal.",
  {
    player: z.string().describe("Player wallet (must match TableSystem.currentActor seat's player)"),
    tableId: z.string().describe("Table id (32-byte hex)"),
    action: z.enum(["fold", "check", "call", "raise"]).describe("Action label"),
    amount: z.string().optional().describe("Numeric string. Required (>0) for raise (absolute round high-bet target). Must be 0 (or omitted) for fold/check/call."),
    salt: z.string().optional().describe("32-byte hex (0x + 64 chars). Optional — CSPRNG if omitted. SAVE for the reveal step."),
  },
  async (args) => pokerCommitActionHandler(args),
);

server.tool(
  "poker_reveal_action",
  "Reveal half of the MS-5 K2 commit-reveal flow. Builds BetSystem.revealAction(tableId, action, amount, salt) as an unsignedTx. Caller MUST supply the exact (action, amount, salt) used in poker_commit_action; BetSystem recomputes commitHashFor with the on-chain handNumber + committed currentBet and reverts CommitRevealMismatch on a mismatch. On success, the disclosed action runs through _doAct just like single-tx `act`. Optional `minBlock` (decimal string) — when set, this tool rejects with E_STALE_HEAD if the chain head < minBlock (Codex 2026-05-24 P1-4 backup defense; agent-runner already runs a multi-plane barrier before calling this, so production callers can pass commit tx receipt.blockNumber for belt-and-suspenders correctness).",
  {
    tableId: z.string().describe("Table id (32-byte hex)"),
    action: z.enum(["fold", "check", "call", "raise"]).describe("Same action committed"),
    amount: z.string().optional().describe("Same amount committed (numeric string)"),
    salt: z.string().describe("Same 32-byte hex salt committed (0x + 64 chars)"),
    minBlock: z.string().optional().describe("Decimal string — refuse to encode if RPC head is behind this block (use commit tx receipt.blockNumber)"),
  },
  async (args) => pokerRevealActionHandler(args),
);

// ═══════════════════════════════════════════
// F-05 permissionless timeout/liveness tools (2026-05-25 Codex end-user audit)
// ═══════════════════════════════════════════
// Without these, a single offline agent freezes the table and the tournament
// cannot finalize — mainnet-blocking for the "no operator, agents only" goal.
// All four are anyone-callable; preflight checks the relevant deadline view so
// the caller doesn't burn gas on a tx the contract would instantly revert.

server.tool(
  "poker_expire_action",
  "Permissionless timeout for a missed betting action. Builds BetSystem.expireAction(tableId) as an unsignedTx. Anyone may call after actionDeadline has passed; the contract defaults the currentActor: Fold if a bet is pending (toCall > 0), Check otherwise. Emits Acted + ActionExpired + ReputationDelta(-10); 3rd consecutive timeout slashes -50 + flags the seat. Preflight rejects with E_DEADLINE_NOT_ARMED (deadline=0; possibly commit-reveal pending — use poker_expire_reveal) or E_DEADLINE_NOT_EXPIRED (head.timestamp < deadline).",
  {
    tableId: z.string().describe("Table id (32-byte hex)"),
  },
  async (args) => pokerExpireActionHandler(args),
);

server.tool(
  "poker_expire_reveal",
  "Permissionless timeout for a missed commit-reveal reveal. Builds BetSystem.expireReveal(tableId) as an unsignedTx. Anyone may call after commitDeadline (60s reveal window) has passed; clears pendingCommit and defaults the currentActor (Fold if pending bet, Check otherwise). Emits RevealExpired + ReputationDelta(-10). Use this in commit-reveal mode; for single-tx mode use poker_expire_action.",
  {
    tableId: z.string().describe("Table id (32-byte hex)"),
  },
  async (args) => pokerExpireRevealHandler(args),
);

server.tool(
  "poker_expire_shuffle",
  "Permissionless timeout for a missed shuffle round. Builds DealSystem.expireShuffle(tableId) as an unsignedTx. Anyone may call after shuffleDeadline has passed; it voids the hand (refunds run inside TableSystem.voidHand) and ELIMINATES the boycotting seat once the per-seat OR table-scoped void streak reaches 3 (rotation-proof liveness). A passive timeout is NOT reputation-slashed — an innocent crash/RPC stall is indistinguishable from intent, so reputation is reserved for a cryptographically PROVEN data-availability fault. Honest agents handed a malformed deck should call poker_report_shuffle_da_fault BEFORE the deadline instead — that proven-fault path slashes the emitter (-10, 3rd → -50) rather than the stuck shuffler.",
  {
    tableId: z.string().describe("Table id (32-byte hex)"),
  },
  async (args) => pokerExpireShuffleHandler(args),
);

server.tool(
  "poker_expire_decrypt",
  "Permissionless timeout for missing decrypt shares. Builds DecryptSystem.expireDecrypt(tableId, cardIdx) as an unsignedTx. Anyone may call after the per-card decryptDeadline has passed; the contract iterates the hand roster, slashes every seat that owed a share (-10 reputation each, 3rd consecutive → -50 + elimination), then voids the hand. cardIdx must name a hole or community card (burn cards have no obligation; CardNotDecryptable revert otherwise).",
  {
    tableId: z.string().describe("Table id (32-byte hex)"),
    cardIdx: z.number().int().min(0).max(51).describe("Card index 0-51 (hole or community)"),
  },
  async (args) => pokerExpireDecryptHandler(args),
);

server.tool(
  "poker_arm_decrypt_deadline",
  "Open the 60s standard-decrypt countdown for a stuck card (ROUND-2 shuffle-reset-deadlock fix). Builds DecryptSystem.armDecryptDeadline(tableId, cardIdx) as an unsignedTx. Anyone-callable. Arm a COMMUNITY card (N-of-N threshold) or a survivor's hole card whose NON-OWNER shares (N-1) a dead/withholding seat is blocking, so the matching poker_expire_decrypt rail can fire (it requires decryptDeadline>0). First arm wins; re-arm reverts DeadlineAlreadyArmed. The contract enforces the per-street community window (PhaseTooEarly) + role legality (CardNotDecryptable for burn/unused). Use with poker_expire_decrypt once the deadline elapses to slash the boycotter and void the hand (honest seats refunded).",
  {
    tableId: z.string().describe("Table id (32-byte hex)"),
    cardIdx: z.number().int().min(0).max(51).describe("Card index 0-51 (hole or community)"),
  },
  async (args) => pokerArmDecryptDeadlineHandler(args),
);

server.tool(
  "poker_expire_unseated",
  "Permissionless prune of a registered no-show (C-01 mainnet readiness fix). Builds TournamentOrchestrator.expireUnseated(tournamentId, agentId) as an unsignedTx. After the post-start UNSEATED_GRACE_PERIOD (5 min default), any caller may expire a registered agent that never took their seat at the bound table — full entry-fee refund queued in pendingRefund, registered counter shrinks so the finalize callback's ranking-length check matches the seated count. Reverts: WrongPhase (tournament not Running), SeatDeadlineNotElapsed (deadline not armed or in the future), AgentAlreadySeated (honest agent), CannotExpireBelowMinPlayers (would drop below the floor; let the seated agents finalize via single-survivor or MAX_HANDS instead), UnknownAgentInRanking (agentId not registered).",
  {
    tournamentId: z.string().describe("Tournament id (32-byte hex)"),
    agentId: z.string().describe("Agent NFT tokenId (numeric string)"),
  },
  async (args) => pokerExpireUnseatedHandler(args),
);

server.tool(
  "poker_arm_owner_share_deadline",
  "Open the 60s hole-card owner-share countdown for a showdown participant (C-02 mainnet readiness fix). Builds DecryptSystem.armOwnerShareDeadline(tableId, cardIdx) as an unsignedTx. Anyone-callable in Phase.Showdown for a hole card. First arm wins; re-arm reverts DeadlineAlreadyArmed. Use with poker_expire_owner_share once the deadline elapses without submission to force-fold the holding seat in ShowdownInvoker. Reverts: NotInShowdown, CardNotDecryptable (not a hole card), OwnerShareAlreadySubmitted.",
  {
    tableId: z.string().describe("Table id (32-byte hex)"),
    cardIdx: z.number().int().min(0).max(51).describe("Hole card index"),
  },
  async (args) => pokerArmOwnerShareDeadlineHandler(args),
);

server.tool(
  "poker_expire_owner_share",
  "Permissionless force-fold a hole-card owner that missed the showdown share deadline (C-02 mainnet readiness fix). Builds DecryptSystem.expireOwnerShare(tableId, cardIdx) as an unsignedTx. Sets the per-card forfeit flag for (tableId, cardIdx, current epoch); ShowdownInvoker treats the holding seat as a forced fold for showdown evaluation. The contested pot is distributed among players who DID reveal; the forfeiting seat keeps its remaining chip stack (forced default loss, NOT a punitive slash — Sahip 2026-05-27 decision). Closes the 'losing player withholds owner share to freeze the table' strategic-veto exploit. Reverts: DeadlineNotArmed, DeadlineNotExpired, OwnerShareAlreadySubmitted, AlreadyForfeited, CardNotDecryptable.",
  {
    tableId: z.string().describe("Table id (32-byte hex)"),
    cardIdx: z.number().int().min(0).max(51).describe("Hole card index"),
  },
  async (args) => pokerExpireOwnerShareHandler(args),
);

server.tool(
  "poker_retry_tournament_finalize",
  "Permissionless retry for a parked finalize callback (C-03 mainnet readiness fix). Builds TableSystem.retryTournamentFinalize(tableId) as an unsignedTx. When the trust-minimized callback into TournamentOrchestrator reverted on first try (registered-no-show pruning needed, transient reentrancy lock, etc.), the ranking is stored on the table side and any caller may flush it via this tool once the orchestrator-side condition has cleared. Success clears the pending state; further retries revert NoPendingFinalize. Without this rail a transient orchestrator revert would strand the tournament in Running even though the table is Complete.",
  {
    tableId: z.string().describe("Table id (32-byte hex)"),
  },
  async (args) => pokerRetryTournamentFinalizeHandler(args),
);

server.tool(
  "poker_table_state",
  "Read live table state: seats (player, agentId, chips, contributions, folded), table (currentActor, phaseName, handNumber, blinds), activeSeats (kanonik in-hand non-folded seat list), round (currentPlayerSeat = TableSystem.currentActor, highBet = RoundState.currentBet, minRaiseAmount = RoundState.minRaise, roundComplete, lastAggressor, actedBitmap), commitRevealEnabled (bool — when true, betting MUST use the commit-reveal 2-tx flow; single-tx poker_action reverts on-chain), and commitReveal {enabled, pending, pendingCommitter, pendingCommitHash, commitDeadline, actionDeadline, revealWindowSeconds:60, coherentSnapshot} — the barrier state a harness uses to run commit→reveal: after poker_commit_action, poll this with minBlock=commit receipt block until pendingCommitHash matches your commit + pendingCommitter==you, then poker_reveal_action within the 60s window (coherentSnapshot is true only when minBlock is passed). Optional `minBlock` (decimal string) reads after head reaches that block — set to last write tx receipt.blockNumber for read-after-write consistency (Codex 2026-05-17 R-F3.12 mitigation).",
  {
    tableId: z.string().describe("Table id"),
    maxSeats: z.number().optional().describe("Number of seat slots to inspect (default 8)"),
    minBlock: z.string().optional().describe("Decimal string — wait until all read RPCs reach >= this block (read-after-write barrier; use receipt.blockNumber from prior write)"),
    quorumK: z.number().int().optional().describe("k-of-n quorum size (default ENV ARC_MCP_QUORUM_K, min(2,N))"),
  },
  async (args) => pokerTableStateHandler(args),
);

server.tool(
  "poker_tournament_state",
  "Read tournament state: admin, token, entryFee, min/max/registered players, phase (Draft/Registering/Running/Finalized/Cancelled), roster, plus the bound tableId/tableSystem, registrationDeadline, seatsOpen and a `joinable` flag.",
  {
    tournamentId: z.string().describe("Tournament id"),
  },
  async (args) => pokerTournamentStateHandler(args),
);

server.tool(
  "poker_discover_open_tournaments",
  "Discover OPEN tournaments on-chain to join — read-only, signs NOTHING, no central lobby/server. Asks the ProtocolRegistry which orchestrator is canonical, scans its TournamentCreated logs over a recent window, and reads each tournament's joinability from public getters. Returns rows with entryFee, seatsOpen, secondsLeft, the bound tableId (no out-of-band hand-off needed), and `joinable`/`onCanonicalToken`/`onCanonicalVersion` flags. The agent applies its own affordability/freshness pre-filter, then an LLM picks a stake; nothing is signed and no money moves until a separate register call. All inputs optional; defaults to the configured USDC token.",
  {
    token: z.string().optional().describe("ERC-20 token address filter; default = configured USDC"),
    maxEntryFee: z.string().optional().describe("Max entryFee in 6-decimal USDC units (integer string); rows above are dropped"),
    minSeatsOpen: z.number().int().nonnegative().optional().describe("Minimum open seats (default 1)"),
    lookbackBlocks: z.number().int().nonnegative().optional().describe("How many recent blocks to scan when the deploy block is unknown"),
    onlyCanonicalVersion: z.boolean().optional().describe("Only tournaments on the registry's canonical version (default true)"),
    limit: z.number().int().positive().optional().describe("Max rows returned (default 50, cap 200)"),
  },
  async (args) => pokerDiscoverOpenTournamentsHandler(args),
);

server.tool(
  "poker_publish_session_pk",
  "Publish your BabyJubJub session pk_i to DealSystem so the joint pk = Σ pk_i can be assembled (real mental-poker pattern, no single-admin trust). Call this ONCE PER TABLE — on the first hand only, BEFORE initDeal. The session key is table-scoped and preserved across every hand; a second publish reverts (SessionPkAlreadyPublished). PRODUCTION: the session seed that derives your sk_i is read from the PLAYER_SESSION_SEED env on the MCP server — never pass a seed in the tool call. The same env seed is reused by poker_decrypt_share / poker_decrypt_batch / poker_recover_card so the derived sk_i matches the published pk_i. TEST-ONLY: the `seed` arg is accepted ONLY when POKER_ALLOW_TOOL_SEED=1 is set on the server (smoke uyumluluğu; per-agent multi-MCP child mainnet pattern). Returns ONLY the public pk + an unsignedTx (sk is NEVER returned — F-04).",
  {
    tableId: z.string().describe("32-byte hex tableId"),
    agentAddress: z.string().describe("REQUIRED (C-1) — the 0x wallet that will sign/broadcast this tx (= on-chain msg.sender). PUBLIC; bound into the Schnorr proof-of-possession so it MUST equal the broadcasting wallet."),
    seed: z.string().optional().describe("Test-only — accepted ONLY when POKER_ALLOW_TOOL_SEED=1. Production reads PLAYER_SESSION_SEED env."),
  },
  async (args) => pokerPublishSessionPkHandler(args),
);

server.tool(
  "poker_hand_start",
  "Coordinator-side hand bootstrap. Reads all published session pks from DealSystem, sums them on BabyJubJub off-chain to get the joint pk, builds the canonical initial 52-card deck encrypted under the joint pk, and returns an unsignedTx for DealSystem.initDeal. Set `withStartHand: true` to also receive a TableSystem.startHand unsignedTx (caller must be admin or authorized system on the table). Run AFTER all seated agents have published their session pk (poker_publish_session_pk — once per table, first hand). Other agents will independently re-verify the joint pk before submitting their shuffle. Optional `minBlock` (decimal string) reads after head reaches that block — set to LAST publishSessionPk receipt.blockNumber for read-after-write consistency (R-F3.12 mitigation, Codex 2026-05-17 mainnet strategy).",
  {
    tableId: z.string().describe("32-byte hex tableId"),
    withStartHand: z.boolean().optional().describe("If true, also returns TableSystem.startHand unsignedTx as `unsignedTxStartHand`."),
    minPks: z.number().int().optional().describe("Minimum number of published pks before assembling joint pk (default 2)."),
    minBlock: z.string().optional().describe("Decimal string — wait until all read RPCs reach >= this block (read-after-write barrier; use receipt.blockNumber from last publishSessionPk write)"),
    quorumK: z.number().int().optional().describe("k-of-n quorum size (default ENV ARC_MCP_QUORUM_K, min(2,N))"),
  },
  async (args) => pokerHandStartHandler(args),
);

server.tool(
  "poker_shuffle_prove",
  // Tool description tells the LLM brain when to use this; semantics matter.
  "Generate the agent's encrypted shuffle proof for the current hand. Reads DealSystem.shuffleRound + handRoster, picks the round-specific circuit (round 0 → shuffle_first, middle rounds → shuffle_mid, final round → shuffle_last), reads the input deck (round 0 from storage; later rounds from the previous round's ShuffleDeckEmitted event), picks fresh randomness (permutation σ + per-card r[]), runs the Groth16 proof (snarkjs ~20 s — slow), and returns an unsignedTx the agent broadcasts. Each agent calls this once per hand in seating order; the chain advances the deck commitment after each accepted round. Call ONLY when it is your turn and DealSystem.shuffleRound matches your expected order. Pass expectedRound to reject stale deck snapshots before proof generation. If this returns E_SHUFFLE_DA_GRIEF, the previous round handed you an inconsistent deck — do NOT shuffle; call poker_report_shuffle_da_fault instead. Optional `seed` makes the proof deterministic (smoke tests only — production must omit for CSPRNG).",
  {
    tableId: z.string().describe("32-byte hex tableId"),
    seed: z
      .string()
      .optional()
      .describe(
        "Optional 256-bit hex seed for deterministic permutation. OMIT in production — CSPRNG is used by default.",
      ),
    expectedRound: z.number().int().optional().describe("Optional DealSystem.shuffleRound expected for this agent. The tool waits briefly and refuses stale deck snapshots."),
  },
  async (args) => pokerShuffleProveHandler(args),
);

server.tool(
  "poker_report_shuffle_da_fault",
  "Adjudicate a shuffle data-availability grief. The gas-optimised shuffle keeps intermediate decks off-chain (emitted in ShuffleDeckEmitted events, bound only by a Poseidon commitment). A malicious round can submit a valid proof yet emit a deck inconsistent with the commitment it proved, freezing the next shuffler — who would otherwise be slashed for 'boycott'. This tool reads the disputed deck, proves its true commitment with the deck_commit circuit (~20 s), and returns an unsignedTx for DealSystem.reportShuffleDAFault that slashes the EMITTER (round-1) instead of the stuck victim. Call this when poker_shuffle_prove returned E_SHUFFLE_DA_GRIEF, or when a table is stuck mid-shuffle. Returns E_NO_DA_FAULT if the previous round was actually honest (then the current shuffler is the real boycotter). Any party may call — a stuck table is everyone's problem.",
  {
    tableId: z.string().describe("32-byte hex tableId"),
  },
  async (args) => pokerReportShuffleDaFaultHandler(args),
);

server.tool(
  "poker_decrypt_share",
  "Compute and submit your partial decryption share for one card. PRODUCTION: session seed env-only (PLAYER_SESSION_SEED). TEST-ONLY: `seed` arg accepted with POKER_ALLOW_TOOL_SEED=1. The tool reads (c1, c2) from DealSystem, computes d = sk_i · c1 on BabyJubJub, generates a Groth16 DLEQ proof binding (pk_i, c1, d), and returns an unsignedTx for DecryptSystem.submitPartialDecryptShare. Hole-card owners must NOT call this for their own card during normal play — submission would revert (HoleOwnerCannotSubmit). Burn / unused slots are also rejected. Once threshold (N-1 hole, N community) is met, RevealReady fires; use poker_recover_card to assemble the plaintext. SHOWDOWN MODE — pass `forShowdown: true` (only valid while table is in Phase.Showdown) to route the share to DecryptSystem.submitOwnerShareForShowdown so the owner can reveal their own card on-chain for ShowdownInvoker.",
  {
    tableId: z.string().describe("32-byte hex tableId"),
    cardIdx: z.number().int().describe("Deck slot 0..51"),
    agentAddress: z.string().optional().describe("Optional agent wallet address — used only for an early local hole-owner check (the contract enforces it regardless)."),
    forShowdown: z.boolean().optional().describe("Owner showdown reveal — routes to submitOwnerShareForShowdown and bypasses the hole-owner short-circuit. Only valid during Phase.Showdown; default false."),
    seed: z.string().optional().describe("Test-only — accepted ONLY when POKER_ALLOW_TOOL_SEED=1. Production reads PLAYER_SESSION_SEED env."),
  },
  async (args) => pokerDecryptShareHandler(args),
);

server.tool(
  "poker_decrypt_batch",
  "Compute several partial decryption shares for the same agent and return one unsignedTx for DecryptSystem.submitPartialDecryptShares. Use this for the flop community-card reveal (three cardIdxs) to keep every DLEQ proof on-chain while reducing tx count. Not for owner showdown reveals. PRODUCTION: session seed env-only (PLAYER_SESSION_SEED). TEST-ONLY: `seed` arg accepted with POKER_ALLOW_TOOL_SEED=1.",
  {
    tableId: z.string().describe("32-byte hex tableId"),
    cardIdxs: z.array(z.number().int()).min(1).max(5).describe("Deck slots 0..51, unique. Flop reveal usually passes three community card indexes."),
    agentAddress: z.string().optional().describe("Optional agent wallet address — used only for early local hole-owner checks."),
    seed: z.string().optional().describe("Test-only — accepted ONLY when POKER_ALLOW_TOOL_SEED=1. Production reads PLAYER_SESSION_SEED env."),
  },
  async (args) => pokerDecryptBatchHandler(args),
);

server.tool(
  "poker_recover_card",
  "Off-chain plaintext recovery for one card slot. Reads every share published on DecryptSystem, sums them on BabyJubJub, computes m = c2 − Σ shares, then maps m to a canonical card identity 1..52 (and decodes suit/rank). For COMMUNITY cards anyone can call this — all shares live on chain. For HOLE cards only the owner can recover: PRODUCTION: owner's session seed is read from PLAYER_SESSION_SEED env (do NOT pass a seed in the tool call) — run on owner's own machine. TEST-ONLY: `ownerSeed` arg accepted with POKER_ALLOW_TOOL_SEED=1. Returns identity 0 with a warning if the recovered point doesn't match any m_k = k·G (cause: missing/duplicate shares, wrong joint pk, etc).",
  {
    tableId: z.string().describe("32-byte hex tableId"),
    cardIdx: z.number().int().describe("Deck slot 0..51"),
    ownerSeed: z.string().optional().describe("Test-only — accepted ONLY when POKER_ALLOW_TOOL_SEED=1. Production reads PLAYER_SESSION_SEED env."),
  },
  async (args) => pokerRecoverCardHandler(args),
);

server.tool(
  "poker_round_status",
  "Aggregated read for phase-orchestration decisions: returns table phase + handNumber + currentActor + occupiedSeats roster + BetSystem RoundState (roundComplete, currentBet, lastAggressor) + per-slot decrypt status (threshold/shareCount/revealed) for every community card belonging to the NEXT phase. Sets `readyToAdvance=true` once roundComplete AND every required community card is fully decrypted — i.e. the gate poker_advance_phase enforces. Cheap to call; pure view, no tx encoded.",
  {
    tableId: z.string().describe("32-byte hex tableId"),
  },
  async (args) => pokerRoundStatusHandler(args),
);

server.tool(
  "poker_hole_status",
  "Aggregated read for HOLE-card decrypt obligations (Path-B): for each hole cardIdx 0..2N-1 returns { cardIdx, holeOwner, isMine, revealed, shareCount, requiredShares, ownerShareSubmitted }, plus derived `iOwe` (peers' hole cardIdxs still needing YOUR non-owner share — submit via poker_decrypt_share / poker_decrypt_batch, ≤5/call; NEVER your own) and `myCardIdxs` (your own two hole cards — recover with poker_recover_card). Ownership is read from DecryptSystem.holeOwnerOf (the on-chain getter applies handRoster[cardIdx % N]); isMine = holeOwner == player. Pure view, no tx encoded — the hole counterpart to poker_round_status's community view.",
  {
    tableId: z.string().describe("32-byte hex tableId"),
    player: z.string().describe("Your wallet address — used to flag isMine / which shares you owe (read-only; nothing is signed)."),
  },
  async (args) => pokerHoleStatusHandler(args),
);

server.tool(
  "poker_advance_phase",
  "Coordinator-side phase transition. Gate: BetSystem.RoundState.roundComplete=true (community-card decrypt happens AFTER advancePhase, not before — the contract rejects an early decrypt). When the HandFlowRouter is configured (production + Path-B default) it returns a SINGLE routed unsignedTx, HandFlowRouter.advancePhaseAndInitRound, for EVERY transition including River → Showdown — this is the only EOA-callable path (dealer-first / seated-fallback, or any caller once the round is complete + currentActor==0xFF); the router internally inits the next betting round for Flop/Turn/River and skips it at Showdown. Fallback (router unset only): bare TableSystem.advancePhase (+ BetSystem.initRound for Flop/Turn/River), which is onlyAuthorizedSystem and reverts NotAuthorized for a plain EOA. Showdown / Complete are rejected (poker_invoke_showdown handles those). Pass `force: true` to skip the roundComplete gate (diagnostic / smoke only).",
  {
    tableId: z.string().describe("32-byte hex tableId"),
    force: z.boolean().optional().describe("Skip the roundComplete + community-revealed gate. Default false."),
  },
  async (args) => pokerAdvancePhaseHandler(args),
);

server.tool(
  "poker_invoke_showdown",
  "Bound-table showdown trigger. Build the ShowdownInvoker.invokeShowdown(tableId) unsignedTx. " +
    "Caller broadcasts with their own PK — the contract is 'Anyone can call' (no admin gate, ShowdownInvoker.sol L87-89). " +
    "Pre-check: table.phase === Showdown; River→Showdown must have advanced first AND every required community card decrypted+revealed. " +
    "Use this from a production agent's deterministic state-machine when dealer-agent === me AND phase === Showdown. " +
    "Gas hardcode 1.5M — bound-table threshold branch (R-F3.11 mined gas 1.13-1.43M, safe buffer). " +
    "After inclusion: ShowdownInvoked event emits roster/holeCards/community/payouts and TableSystem.endHand fires from inside the call.",
  {
    tableId: z.string().describe("32-byte hex tableId"),
  },
  async (args) => pokerInvokeShowdownHandler(args),
);

// ── End-user claim tools (P0-4, Codex public-readiness audit 2026-05-11) ──
// Finalize/cancel sonrasi son kullanici akisini kapatir: agent owner
// kazandigi/iadesini cekebilsin, depositor kullanmadigi prepay'i geri alabilsin.

server.tool(
  "poker_claim_payout",
  "Pull a finalized tournament prize. MS-2 pull-over-push: finalizeFromCallback queues pendingPayout[T][agentId]; only the ERC-8004 owner of agentId can call. Returns 1 unsigned tx.",
  {
    player: z.string().describe("Agent owner wallet (must equal IdentityRegistry.ownerOf(agentId))."),
    tournamentId: z.string().describe("Tournament id (32-byte hex)"),
    agentId: z.string().describe("ERC-8004 agent token id (numeric string)"),
  },
  async (args) => pokerClaimPayoutHandler(args),
);

server.tool(
  "poker_claim_refund",
  "Pull a cancelled-tournament refund (full entry fee — rake never moved during Registering). Only callable when tournament phase is Cancelled and pendingRefund > 0. Same agent-owner gate as claim_payout. Returns 1 unsigned tx.",
  {
    player: z.string().describe("Agent owner wallet (must equal IdentityRegistry.ownerOf(agentId))."),
    tournamentId: z.string().describe("Tournament id (32-byte hex)"),
    agentId: z.string().describe("ERC-8004 agent token id (numeric string)"),
  },
  async (args) => pokerClaimRefundHandler(args),
);

server.tool(
  "poker_withdraw_pending_deposit",
  "Recover an unconsumed depositFor slot. Callable during Registering or Running phases by the original depositor wallet (no agent-ownership requirement). Use when you sent depositFor but never called register, or to clean up a phantom slot. Returns 1 unsigned tx.",
  {
    depositor: z.string().describe("Original depositor wallet (must equal the address that originally called depositFor)."),
    tournamentId: z.string().describe("Tournament id (32-byte hex)"),
    agentId: z.string().describe("ERC-8004 agent token id (numeric string)"),
  },
  async (args) => pokerWithdrawPendingDepositHandler(args),
);

// CRITICAL: Never console.log — corrupts JSON-RPC pipe
process.stderr.write("agenticzk-mcp server starting...\n");

// Codex 2026-05-24 P2-3 — process-level seed guard fail-fast.
//
// POKER_ALLOW_TOOL_SEED=1 / POKER_ALLOW_SEED=1 are test-only flags that open
// the `seed`/`ownerSeed` argument paths on poker_publish_session_pk,
// poker_decrypt_share/batch, poker_recover_card, poker_shuffle_prove. Per-tool
// guards already gate the args, but a misconfigured production launch (env
// inherited from a CI test runner) could leave the seed door open everywhere
// at once. We fail fast here so the operator cannot start the MCP server
// against mainnet with test-only seed paths active.
//
// Bypass policy:
//   NODE_ENV=test  →  flags accepted (CI + local smoke regression)
//   NODE_ENV=*     →  flags rejected with hard process.exit(1)
//
// MC-01 fix (2026-05-22) lives at the tool layer; this is the process-wide
// belt-and-suspenders ring.
{
  const seedFlag = process.env.POKER_ALLOW_TOOL_SEED === "1" || process.env.POKER_ALLOW_SEED === "1";
  const isTest = process.env.NODE_ENV === "test";
  if (seedFlag && !isTest) {
    process.stderr.write(
      "FATAL: POKER_ALLOW_TOOL_SEED / POKER_ALLOW_SEED is set but NODE_ENV !== 'test'. " +
        "These flags open test-only seed argument paths on poker_publish_session_pk, " +
        "poker_decrypt_share / poker_decrypt_batch, poker_recover_card and poker_shuffle_prove; " +
        "they MUST NOT be active in production. Unset both env vars and restart.\n",
    );
    process.exit(1);
  }
}

// 2026-06-22 (Path B build, FIX-3) — register the play_full_hand prompt + the
// protocol-spec resource. CRITICAL: these MUST be registered BEFORE
// server.connect(transport) — the SDK throws "Cannot register capabilities after
// connecting to transport" if a capability (prompt/resource) is added after
// connect. Do NOT move these below the connect call. The tool-counter wrapper
// above only intercepts server.tool, so registerPrompt/registerResource do not
// affect the reported tool count.
server.registerPrompt(
  "play_full_hand",
  {
    title: "Play a full AgenticZK hand (Path B)",
    description:
      "Ready-to-run prompt that drives a full on-chain Texas Hold'em hand via the " +
      "AgenticZK transport tools in the correct order (register → publish_session_pk → " +
      "shuffle → start_hand → decrypt → commit/reveal bet → advance_phase → invoke_showdown → " +
      "reset). For Path B (CLI + MCP + signer, no agent-runner). The MCP signs nothing.",
    argsSchema: {
      tableId: z.string().describe("Table id (32-byte hex)"),
      tournamentId: z.string().describe("Tournament id (32-byte hex)"),
      agentId: z.string().describe("ERC-8004 agent token id (numeric string)"),
      player: z.string().describe("Your wallet address (the signer; PLAYER_PK stays in your harness)"),
    },
  },
  ({ tableId, tournamentId, agentId, player }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: buildPlayFullHandPrompt({ tableId, tournamentId, agentId, player }),
        },
      },
    ],
  }),
);

server.registerResource(
  "protocol-spec",
  "agenticzk://protocol/full-hand",
  {
    title: "AgenticZK full-hand protocol (Path B)",
    description:
      "Detailed step-by-step per-street play loop for driving a full on-chain hand " +
      "via the MCP transport tools (mirrors the production state-machine order). Static text.",
    mimeType: "text/markdown",
  },
  (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/markdown",
        text: PROTOCOL_SPEC_RESOURCE,
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);

// audit 2026-05-22 MC-15/D5 — kategori bazlı dinamik sayım, hard-coded drift yok.
const _pokerNames = REGISTERED_TOOLS.filter((n) => n.startsWith("poker_"));
const _claimNames = _pokerNames.filter(
  (n) => n.includes("claim") || n.includes("withdraw"),
);
const _pokerCore = _pokerNames.length - _claimNames.length;
const _baseNames = REGISTERED_TOOLS.length - _pokerNames.length;
process.stderr.write(
  `agenticzk-mcp server connected. ${REGISTERED_TOOLS.length} tools registered (${_baseNames} base + ${_pokerCore} poker + ${_claimNames.length} claim).\n`,
);
