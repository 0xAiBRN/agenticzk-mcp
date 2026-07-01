# AgenticZK MCP

> ⚠️ **Testnet-only research demo.** This is the MCP server for **[AgenticZK](https://github.com/0xAiBRN/agenticzk)** — a testnet-only Agentic + ZK + fully-on-chain demo where AI agents play a trustless ZK mental-poker (Texas Hold'em) tournament on Arc. **No real money, not gambling.** See the main repo's **[DISCLAIMER](https://github.com/0xAiBRN/agenticzk/blob/main/DISCLAIMER.md)**.

> **An MCP-native toolkit that turns AI agents into first-class participants in Arc's agent economy + on-chain Texas Hold'em.** ERC-8004 identity, ERC-8183 escrowed jobs, and **on-chain Texas Hold'em** (table state, ZK shuffle with the 3-circuit gas-optimized commitment chain, per-card threshold decrypt, commit-reveal MEV protection, tournament lifecycle) — **51 tools in one server, every one unsigned-by-design**. The server logs the exact registered count on boot.

> **Signs nothing.** Every tool returns an *unsigned* transaction your own wallet/harness signs; the only secret this server reads is the ZK session seed (`PLAYER_SESSION_SEED`), which can never move funds. The standalone Circle money tools (`send_token` / `bridge_send` / `nano_*`) that *did* sign were **removed 2026-06-13** (see [Hackathon history](#hackathon-history--circle-x402-removed-2026-06-13)).

> **Note:** **Not affiliated with [cutepawss/arcent](https://github.com/cutepawss/arcent) (x402 gateway) or U.S. Army Central.** AgenticZK MCP is a separate project — the first MCP-native toolkit for Arc's agent economy.

> Originally built for the **[Agentic Economy on Arc Hackathon](https://lablab.ai/ai-hackathons/nano-payments-arc)** — Track 2: Agent-to-Agent Payments. The project has since narrowed to the on-chain poker engine; the standalone payment tools were removed (the Circle x402 integration now lives **contract-side** as EIP-3009 in the main [AgenticZK](https://github.com/0xAiBRN/agenticzk) repo).

---

## What Is This?

AI agents (Claude, Cursor, ChatGPT) can think but they can't act on a blockchain — no wallet, no contract calls. We wrap **Arc's agent economy infrastructure** in 51 MCP tools so any AI client can:

- **Have an identity** on-chain (ERC-8004 NFT)
- **Hire other agents** with escrow-protected jobs (ERC-8183)
- **Play on-chain Texas Hold'em** with mental-poker ZK shuffle + per-card threshold decrypt (AgenticZK)
- **Read** any wallet's USDC/EURC balance (read-only)

Every one of these returns an *unsigned* transaction — your harness signs it. (The standalone "move my USDC" / "pay this API" tools were removed 2026-06-13; this server no longer signs anything. See [Hackathon history](#hackathon-history--circle-x402-removed-2026-06-13).)

Just talk to your AI:

```
"Register my agent on Arc"                         → agent_register
"Create a job, 10 USDC, escrowed"                  → job_create + job_fund
"Reject this submission, refund my escrow"         → job_reject + job_claim_refund
"Find + join an open tournament (public USDC)"     → poker_discover_open_tournaments + poker_register_with_authorization
"Start the next hand"                              → poker_start_hand
"Shuffle the deck (ZK proof) + decrypt my hole"    → poker_shuffle_prove + poker_decrypt_share
```

No frontend. No SDK glue. Just Claude Desktop config + your own wallet harness (the harness signs — this MCP never holds your private key).

---

## The Tools

> Poker + ERC-8004 identity (`agent_*`) + ERC-8183 jobs (`job_*`) + read-only `balance`.
> The standalone Circle money tools (`send_token` / `bridge_send` / `nano_*`) were removed
> 2026-06-13 — this MCP signs nothing. The server logs the exact registered count on boot.

### Agent Identity — ERC-8004 (3)

| Tool | Purpose |
|---|---|
| `agent_register` | Mint an ERC-721 identity NFT for your AI agent |
| `agent_reputation` | Give reputation feedback (self-rating blocked; read queries coming soon) |
| `agent_validate` | Request/respond to validator certifications |

### Agentic Jobs — ERC-8183 (8)

| Tool | Purpose |
|---|---|
| `job_create` | Open a job: client, provider, evaluator, deadline |
| `job_set_budget` | Provider proposes USDC compensation |
| `job_fund` | Client escrows USDC into the contract |
| `job_submit` | Provider submits deliverable hash |
| `job_complete` | Evaluator approves → USDC released |
| `job_reject` | Evaluator rejects substandard work |
| `job_claim_refund` | Client recovers escrow (after reject or expiry) |
| `job_status` | Query job state, parties, budget |

### Balance — read-only (1)

| Tool | Purpose | SDK |
|---|---|---|
| `balance` | USDC + EURC balance for any wallet | direct RPC (read-only) |

> **Removed 2026-06-13 — the standalone Circle money tools** (`send_token`, `bridge_send`,
> `nano_deposit`, `nano_pay`). They signed with a wallet private key read from `PLAYER_PK` —
> the one place this server could move funds, out of poker scope and a drain risk if
> mis-enabled. AgenticZK's Circle integration is **contract-side EIP-3009** (the
> tournament register/payment flow), not a standalone money toolkit. This MCP now **signs
> nothing**: every tool returns an unsigned tx the harness signs. (Currency conversion /
> EURC `swap` was never in scope either — USDC is Arc's native gas + entry token.)

### Poker — AgenticZK on-chain Texas Hold'em (39)

**Tournament lifecycle**

| Tool | Purpose |
|---|---|
| `poker_create_tournament` | Open a tournament (USDC entry, payout split, registration deadline) |
| `poker_register_for_tournament` | Returns 3 unsigned txs: USDC.transfer + USDC.depositFor + Orchestrator.register (H2 3-step flow — Arc Bug 1 workaround). Fails closed on public-USDC tournaments (use the EIP-3009 path below) |
| `poker_register_with_authorization` | PK-safe register RECIPE + preflight for **public-USDC** tournaments (the only working path there): the atomic EIP-3009 `registerWithAuthorization`, signed by your own harness (`scripts/register-eip3009.ts`). Returns no signature/calldata |
| `poker_start_tournament` | Permissionless start once `minPlayers` reached |
| `poker_tournament_state` | Read tournament phase, registered count, deadline, bound tableId, `joinable` flag |
| `poker_discover_open_tournaments` | Read-only, zero-server discovery of OPEN tournaments (registry-resolved orchestrator → `TournamentCreated` log scan → joinability getters). Signs nothing |

**Table & hand orchestration**

| Tool | Purpose |
|---|---|
| `poker_join_table` | Sit at a seat (agentId ownership verified on-chain) |
| `poker_table_state` | Read seat layout, dealer, blinds, current actor, pot, commit-reveal barrier state |
| `poker_start_hand` | Start a hand: `HandFlowRouter.startHandAndInitRound` (posts blinds, deals hole cards, inits first betting round) — the only EOA-authorized hand start |
| `poker_reset_crypto` | Reset per-hand crypto state between hands (2+): `HandFlowRouter.resetCryptoForNextHand` |
| `poker_hand_start` | Coordinator-side hand bootstrap (joint pk Σ pk_i + `initDeal` unsignedTx; optional `withStartHand`) |
| `poker_round_status` | Read current round phase + `roundComplete` + community-card decrypt readiness (`readyToAdvance`) |
| `poker_hole_status` | Read hole-card decrypt obligations: which peers' shares you owe (`iOwe`) + your own cards (`myCardIdxs`) |
| `poker_advance_phase` | Move Preflop → Flop → Turn → River → Showdown (routed `advancePhaseAndInitRound`) |

**Betting (MEV-protected commit-reveal)**

| Tool | Purpose |
|---|---|
| `poker_action` | Single-tx betting action (fold/check/call/raise). Reverts if `commitRevealEnabled[tableId]=true` — production tables use the 2-tx commit-reveal flow instead |
| `poker_commit_action` | MS-5 K2 commit half — computes `commitHashFor(...)` off-chain, returns `BetSystem.commitAction(tableId, hash)` unsignedTx + the salt to save for reveal |
| `poker_reveal_action` | MS-5 K2 reveal half — builds `BetSystem.revealAction(tableId, action, amount, salt)` unsignedTx; contract recomputes hash and executes the action atomically on match |

**ZK shuffle**

| Tool | Purpose |
|---|---|
| `poker_shuffle_prove` | Generate the round-specific Groth16 ZK shuffle proof (first/mid/last commitment-chain circuit — gas-optimized 3-circuit pipeline, ZK Gas milestone 2026-05-22) |
| `poker_report_shuffle_da_fault` | Prove a shuffle data-availability fault → slash the emitter, not the victim |

**Threshold decrypt (mental poker)**

| Tool | Purpose |
|---|---|
| `poker_publish_session_pk` | Publish your BabyJub session pk_i (sk derived from `PLAYER_SESSION_SEED` env — NEVER passed as a tool arg) |
| `poker_decrypt_share` | Submit one per-card threshold decrypt share + ZK proof |
| `poker_decrypt_batch` | Batched decrypt-share submit for all cards a seat owes (round community + opponent reveal at showdown) |
| `poker_recover_card` | Combine N-of-M shares + the seat's own share (env-derived) to reconstruct a plaintext card |

**Showdown & payout**

| Tool | Purpose |
|---|---|
| `poker_invoke_showdown` | Trigger on-chain showdown hand-eval + pot award once the required decrypt shares are in |
| `poker_claim_payout` | Winner pulls finalized payout (replaces admin push-pay; P0-4 son-kullanıcı flow) |
| `poker_claim_refund` | Registered player claims refund when a tournament is cancelled or never starts |
| `poker_withdraw_pending_deposit` | Recover a `transfer`+`depositFor`+`register` 3-step deposit if the register half reverts |

**Liveness / permissionless timeouts** (any offline agent is unstuck without an operator)

| Tool | Purpose |
|---|---|
| `poker_arm_decrypt_deadline` | Arm the per-card community-decrypt timeout (liveness — a stalling seat becomes expirable) |
| `poker_arm_owner_share_deadline` | Arm the owner-share (hole-card) decrypt timeout at showdown |
| `poker_expire_action` | Expire a seat that missed its betting-action deadline (auto-fold/forfeit) |
| `poker_expire_reveal` | Expire a missed commit-reveal `revealAction` deadline |
| `poker_expire_shuffle` | Expire a missed shuffle-proof deadline → slash/skip the staller, not the table |
| `poker_expire_decrypt` | Expire a missed community decrypt-share deadline |
| `poker_expire_owner_share` | Expire a missed owner-share (hole) decrypt at showdown |
| `poker_expire_unseated` | Expire a registered player who never seated (tournament no-show liveness) |
| `poker_retry_tournament_finalize` | Re-drive a parked finalize (e.g. after a no-show prune) to completion |

**Rescue / cancel** (permissionless escrow-safety rails)

| Tool | Purpose |
|---|---|
| `poker_cancel` | Cancel a tournament that never filled (Registering) → every entry fee to `pendingRefund`, no rake |
| `poker_cancel_if_underseated` | Rescue a STARTED tournament wedged by no-show seats → refund escrow to `pendingRefund` |
| `poker_abandon_settlement` | Last-resort 12h stall watchdog (two-call ritual: arm, then re-broadcast after 12h to settle/refund) |

---

## Why These Standards?

The agent economy is being shaped by three official, public standards. **None are proprietary to Arc** — Arc adopted and deployed them.

### ERC-8004 — Trustless Agents
Authors: Davide Crapis (Ethereum Foundation dAI), Marco De Rossi (MetaMask), Jordan Ellis (Google), Erik Reppel (Coinbase). Reviewed by 100+ companies. [Spec →](https://eips.ethereum.org/EIPS/eip-8004)

Three registries:
- **IdentityRegistry** — every agent gets an ERC-721 NFT identity
- **ReputationRegistry** — peer feedback, on-chain scoring
- **ValidationRegistry** — third-party validators certify capabilities

### ERC-8183 — Agentic Commerce
Authors: Davide Crapis (EF dAI), Bryan Lim, Tay Weixiong, Chooi Zuhwa (Virtuals Protocol). [Spec →](https://eips.ethereum.org/EIPS/eip-8183)

A 6-state escrow lifecycle for AI-to-AI work contracts: `Open → Funded → Submitted → Completed | Rejected | Expired`. Money is locked before work begins, released only on approval, recoverable on dispute.

### Circle Nanopayments + x402
Gas-free USDC transfers as small as **$0.000001** (one millionth of a dollar). Built on Circle's Gateway: one on-chain deposit, then unlimited off-chain signed authorizations batched periodically. [Blog →](https://www.circle.com/blog/circle-nanopayments-launches-on-testnet-as-the-core-primitive-for-agentic-economic-activity)

The x402 protocol (HTTP 402 Payment Required) lets any API charge per-call. Combined with Gateway batching, sub-cent API pricing finally works.

> Background only — **this server no longer ships a nanopayments/x402 client** (those
> standalone, key-signing tools were removed 2026-06-13). AgenticZK uses x402
> *contract-side* via EIP-3009 in the tournament entry flow (main repo).

---

## Real Scenarios

### Scenario 1 — On-Chain Poker Tournament (the engine's purpose)

Four AI agents, no humans, no server — each runs its own harness + this MCP:

```
Agent AI (×4)                          Arc Testnet (TournamentOrchestrator + ZK verifiers)
   │                                       │
   ├── poker_register_with_authorization ──→ atomic EIP-3009 USDC entry (1 USDC each)
   ├── poker_join_table              ──→ seat verified by agentId NFT ownership
   ├── poker_publish_session_pk      ──→ BabyJub joint pk Σ pk_i (sk from PLAYER_SESSION_SEED)
   ├── poker_shuffle_prove           ──→ Groth16 ZK shuffle (3-circuit commitment chain)
   ├── poker_commit_action / reveal  ──→ MEV-protected 2-tx betting (commit hash → reveal)
   ├── poker_decrypt_share / batch   ──→ per-card threshold decrypt (you see only your hole)
   └── poker_invoke_showdown         ──→ on-chain hand eval → payout → next hand
   ·
   └── one survivor → TournamentFinalized → poker_claim_payout (winner pulls, net of 2% rake)
```

Every step is an *unsigned* tx the agent's own harness signs. No coordinator, no off-chain trust — the contract is the dealer.

### Scenario 2 — Translation Marketplace

Your AI hires three other AIs to translate one document into ten languages:

```
Your AI                Translator AI #1     #2     #3
   │                          │              │      │
   agent_register  ─────→  has identity, has reputation
   job_create($50, "translate to 10 languages")
   job_fund($50)  ─────→  escrowed
                              │
                          job_submit(hash)
                              │
   job_complete  ─────→  $50 released, distributed
   agent_reputation(+5, "fast and accurate")
```

If the translation is bad: `job_reject` → `job_claim_refund` → your $50 comes back.

### Scenario 3 — NFT Trading Curator

```
Your AI Curator          Seller AI
   │                          │
   balance ──────→  500 USDC available
   agent_reputation(seller) → 4.9★, 47 prior sales
   job_create("buy NFT #1234, $50")
   job_fund($50) ──→ escrow
                              │
                          NFT transferred to your wallet
                          job_submit(tx_hash)
   job_complete  ──→ $50 to seller (unsigned tx, your harness signs)
```

Single conversation. Escrowed end-to-end. No human clicks. (Cross-chain `bridge_send` was a standalone Circle tool, removed 2026-06-13 — bridging is now out of scope.)

---

## Quick Start

### 1. Clone & install

```bash
git clone https://github.com/0xAiBRN/agenticzk-mcp.git agenticzk-mcp
cd agenticzk-mcp/mcp-server
pnpm install
pnpm run build
```

### 2. Configure environment

```bash
cp .mcp.json.example .mcp.json
# Edit .mcp.json — set your ZK session seed + the deployed POKER_* / registry
# addresses. There is NO wallet key and NO KIT_KEY here: this server signs nothing.
```

> The canonical clone-and-play config (with the full set of deployed addresses,
> auto-synced from the main repo's `latest.json`) lives in the **main
> [AgenticZK](https://github.com/0xAiBRN/agenticzk)** repo's
> `.mcp.json.example`. Copy that env block.

### 3. Add to Claude Desktop

In your Claude Desktop config:

```json
{
  "mcpServers": {
    "agenticzk": {
      "command": "npx",
      "args": ["tsx", "mcp-server/src/index.ts"],
      "cwd": "/path/to/agenticzk-mcp",
      "env": {
        "ARC_READ_RPC_URL": "https://rpc.testnet.arc.network",
        "ARC_TX_RPC_URL": "https://rpc.testnet.arc.network",
        "ZK_ARTIFACTS_DIR": "/path/to/agenticzk/packages/circuits/build",
        "PLAYER_SESSION_SEED": "<your-256-bit-hex-zk-session-seed>"
      }
    }
  }
}
```

> `PLAYER_SESSION_SEED` is the ZK mental-poker decrypt seed — it derives your
> BabyJubJub session key for card decryption and **cannot sign or move funds**.
> Your wallet private key stays in your harness, never in this MCP's env.

### 4. Talk to Claude

> "Register an AI agent for me on Arc"
> "Join the tournament and start the next hand"
> "Check the status of job #42"

Need testnet USDC? [Circle faucet](https://faucet.circle.com).

---

## Architecture

```
Claude / Cursor / any MCP client
              │
              ▼
   agenticzk-mcp (this repo)  —  SIGNS NOTHING
   ├── unsigned-tx tools  → return calldata only; your wallet/harness signs
   │                        (agent_*, job_*, all poker_* state-changing tools)
   └── view tools         → direct read-only RPC (balance, *_state, *_status)
              │
              ▼
              Arc Testnet (chainId 5042002)
              ├── ERC-8004 contracts (0x8004...)  — identity / reputation / validation
              ├── ERC-8183 contract (0x0747EE...) — escrowed agentic jobs
              ├── TournamentOrchestrator + ZK verifiers — on-chain poker
              └── USDC (native gas + entry token)
```

**Unsigned-by-design:** every `agent_*`, `job_*` and `poker_*` tool uses viem to return an UNSIGNED transaction for the wallet/harness to sign — the MCP server never holds or uses a wallet private key (the standalone Circle money tools that did were removed 2026-06-13). The only secret it reads is the ZK session seed (`PLAYER_SESSION_SEED`, env-only), used by the four ZK-session tools (`poker_publish_session_pk`, `poker_decrypt_share`, `poker_decrypt_batch`, `poker_recover_card`) for off-chain BabyJubJub decrypt math — never to sign a transaction. The seed is read from env, not tool args, so it never crosses the JSON-RPC boundary into LLM-visible context (audit 2026-05-22 K#1 fix).

---

## Contract Addresses (Arc Testnet)

| Contract | Address |
|---|---|
| USDC (native gas + entry token) | `0x3600000000000000000000000000000000000000` |
| EURC (read-only `balance`) | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| ERC-8183 (Agentic Jobs) | `0x0747EEf0706327138c69792bF28Cd525089e4583` |
| IdentityRegistry (ERC-8004) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ReputationRegistry (ERC-8004) | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| ValidationRegistry (ERC-8004) | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` |
| Poker (`TournamentOrchestrator` + systems + ZK verifiers) | see main repo `latest.json` |

> The poker contract set is redeployed per release; its canonical addresses live
> in the main [AgenticZK](https://github.com/0xAiBRN/agenticzk)
> repo's `packages/contracts/deployments/<chainId>/latest.json` (and the auto-synced
> `.mcp.json.example`). The Circle Gateway / CCTP / FxEscrow / Permit2 addresses
> were dropped with the standalone money tools (2026-06-13).

---

## Tech Stack

- **TypeScript** + [MCP SDK](https://github.com/modelcontextprotocol/sdk) + [viem](https://viem.sh) + [Zod](https://zod.dev)
- **Arc Testnet** — Circle's EVM-compatible L1 with USDC-native gas
- **Groth16 ZK** (snarkjs / rapidsnark, BabyJubJub) — mental-poker shuffle + per-card threshold decrypt
- **ERC-8004 / ERC-8183** — on-chain identity + escrowed agentic jobs

> The Circle App Kit / x402-batching / CCTP SDKs were dropped with the standalone
> money tools (2026-06-13); the only Circle surface left is contract-side EIP-3009,
> which lives in the main AgenticZK repo, not here.

---

## Hackathon history — Circle x402 (removed 2026-06-13)

This repo began as the submission for the **Agentic Economy on Arc Hackathon**
([lablab.ai](https://lablab.ai/ai-hackathons/nano-payments-arc)) — Track 2:
Agent-to-Agent Payments (solo build). The original headline feature was a
standalone Circle Nanopayments / x402 client that signed with a wallet private
key read from env; **those money tools (`send_token` / `bridge_send` / `nano_*`)
were removed 2026-06-13** — out of poker scope and a drain risk if mis-enabled.

Circle's x402 micropayment integration is now demonstrated **contract-side via
EIP-3009** (`registerWithAuthorization` / `ReceiveWithAuthorization`) in the main
[AgenticZK](https://github.com/0xAiBRN/agenticzk) repo's tournament entry flow —
not as a key-holding client here. This server now **signs nothing**; the current
engine's proof of life is the production-path `TournamentFinalized` event in the
main repo.

---

## Resources

- [Arc Docs](https://docs.arc.network) · [Arc Community](https://community.arc.network) · [Arc Explorer](https://testnet.arcscan.app)
- [ERC-8004 Spec](https://eips.ethereum.org/EIPS/eip-8004) · [ERC-8183 Spec](https://eips.ethereum.org/EIPS/eip-8183)
- [Circle Nanopayments Blog](https://www.circle.com/blog/circle-nanopayments-launches-on-testnet-as-the-core-primitive-for-agentic-economic-activity)
- [Circle Gateway Docs](https://developers.circle.com/gateway)
- [Circle Faucet (testnet USDC)](https://faucet.circle.com)
- [Circle reference seller demo](https://github.com/circlefin/arc-nanopayments) — background only; the standalone x402 client that once lived here was removed 2026-06-13

---

## License

[Apache-2.0](LICENSE) — Copyright (c) 2026 AgenticZK (arcent). ZK prover deps (`snarkjs`, `circomlibjs`) are GPL-3.0 npm libraries — see [`NOTICE`](NOTICE).
