# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/spec/v2.0.0.html)

All notable changes to `agenticzk-mcp` are tracked here. This is the MCP server
for **AgenticZK — a testnet-only Agentic + ZK + fully-on-chain research demo**
(see [`DISCLAIMER.md`](DISCLAIMER.md)). It is **unsigned-by-design**: every tool
returns an unsigned transaction your own wallet/harness signs.

## [1.0.0] — Public V1 (testnet demo)

The MCP server as published for AgenticZK Public V1. **51 tools, every one
unsigned-by-design** (the server logs the exact registered count on boot):

- **3** ERC-8004 agent identity tools (`agent_register`, `agent_reputation`, `agent_validate`)
- **8** ERC-8183 escrowed job tools (`job_create`, `job_set_budget`, `job_fund`, `job_submit`, `job_complete`, `job_reject`, `job_claim_refund`, `job_status`)
- **1** read-only `balance` view
- **39** on-chain Texas Hold'em (`poker_*`) tools — tournament lifecycle, table/hand orchestration, MEV-protected commit-reveal betting, 3-circuit gas-optimized ZK shuffle, per-card threshold decrypt, showdown/payout, permissionless liveness timeouts, and escrow-safety rescue/cancel rails

### Added
- `poker_register_with_authorization` — PK-safe EIP-3009 register recipe + preflight for **public-USDC** tournaments (the only working register path there); the harness signer (`scripts/register-eip3009.ts`) holds the key.
- `poker_discover_open_tournaments` — read-only, zero-server discovery of open tournaments (registry-resolved orchestrator → `TournamentCreated` log scan → joinability getters).
- `poker_hole_status`, `poker_start_hand`, `poker_reset_crypto`, `poker_cancel`, `poker_cancel_if_underseated`, `poker_abandon_settlement`, and the C-01/02/03 liveness rails (`poker_expire_unseated`, `poker_arm_owner_share_deadline`, `poker_expire_owner_share`, `poker_retry_tournament_finalize`).
- Fee disclosure surfaced on both register tools (2% rake = 1% house + 1% organizer, taken from the prize pool at finalize only; entry fee fully refundable on cancel/abandon).
- Community/OSS files: `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `DISCLAIMER.md`, `NOTICE`, this `CHANGELOG.md`.

### Changed
- Rebranded from `arcent-poker-mcp` / "Arcent Agent MCP" to **AgenticZK** (package `agenticzk-mcp`, repo `github.com/0xAiBRN/agenticzk-mcp`). Technical tool identifiers (`poker_*`, `agent_*`, `job_*`) unchanged.
- `poker_register_for_tournament` now resolves the canonical orchestrator via `ProtocolRegistry.getActiveRelease()` (drift-proof), matching `poker_register_with_authorization` / `poker_discover_open_tournaments` — both register paths target the same active/gated orchestrator.
- Startup log reports the tool count dynamically (no hard-coded drift).

### Removed
- **The standalone Circle money tools (`send_token`, `bridge_send`, `nano_deposit`, `nano_pay`) were removed 2026-06-13.** They signed with a wallet private key read from env — the one place this server could move funds, out of poker scope and a drain risk if mis-enabled. This MCP now signs nothing. AgenticZK's Circle x402 integration lives **contract-side** as EIP-3009 (`registerWithAuthorization` / `ReceiveWithAuthorization`) in the main repo.
- The unused `@circle-fin/x402-batching` SDK and the standalone `test-seller/` x402 gateway harness + `demos/nano-*.json` settlement artifacts were dropped (preserved in private backups; the historical hackathon settlement run is documented in `README.md`).
- The dead `poker_finalize_tournament` tool (finalize is automatic via the `invoke_showdown` → orchestrator callback; `poker_retry_tournament_finalize` is the recovery rail).

### Security
- Process-level seed guard: hard-exits if `POKER_ALLOW_TOOL_SEED` / `POKER_ALLOW_SEED` is set while `NODE_ENV !== "test"`, so test-only seed argument paths cannot be active in production.
- `PLAYER_SESSION_SEED` is read from env only, never a tool argument — it never crosses the JSON-RPC boundary into LLM-visible context.

---

**Note:** Detailed phase history and the decision log live in the maintainer's living plan and in the main [AgenticZK](https://github.com/0xAiBRN/agenticzk) repo's `CHANGELOG.md`, not in this repo.
