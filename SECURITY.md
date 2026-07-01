# Security Policy

## Reporting a Vulnerability

**Primary channel — GitHub Private Vulnerability Reporting:**
<https://github.com/0xAiBRN/agenticzk-mcp/security/advisories/new>

**Backup channel — Email:** `0x@arcent.ink`

Public issues, pull requests, and Discussions are **not** appropriate disclosure channels.

What to include:
- Affected tool or module (which `poker_*` / `agent_*` / `job_*` / `balance` tool, or a shared helper like `resolve-orchestrator.ts` / `chains.ts` / `config.ts`)
- Steps to reproduce (proof-of-concept welcome)
- Impact assessment (what an attacker gains)
- Suggested mitigation (optional)

We will acknowledge within 72 hours and triage within 7 days.

## Security model — this server SIGNS NOTHING

The single most important security property of `agenticzk-mcp`:

- **Every state-changing tool returns an *unsigned* transaction** (calldata / a recipe + preflight). Your own wallet/harness signs and broadcasts it. This MCP never holds, reads, or uses a wallet private key.
- **View tools** (`balance`, `poker_*_state`, `poker_*_status`, `poker_discover_open_tournaments`) are direct read-only RPC calls — no signing, no state change.
- **The only secret the server reads is `PLAYER_SESSION_SEED`** — a ZK mental-poker session seed. It derives your BabyJubJub session key for card decryption (`poker_publish_session_pk`, `poker_decrypt_share`, `poker_decrypt_batch`, `poker_recover_card`). It **cannot sign a transaction or move funds**. It is read from env, never from a tool argument, so it never crosses the JSON-RPC boundary into LLM-visible context (audit 2026-05-22 K#1 fix).
- The standalone Circle money tools (`send_token` / `bridge_send` / `nano_*`) that *did* sign with a wallet key were **removed 2026-06-13**. There is no wallet-PK signing surface left in this server.
- **Test-only seed flags** (`POKER_ALLOW_TOOL_SEED=1` / `POKER_ALLOW_SEED=1`) open `seed`/`ownerSeed` tool arguments for CI/smoke. A process-level guard **hard-exits** if either is set while `NODE_ENV !== "test"`, so they cannot be active in a production launch.

Because the server signs nothing, the classic "MCP drains my wallet" risk does not apply here. The correct threat model is: **wrong unsigned tx** (a tool encodes calldata that harms the signer if broadcast) or **leaked seed** (an attacker who obtains `PLAYER_SESSION_SEED` could read your hole cards, but still cannot move funds).

## Supported Versions

| Version | Status | Security fixes |
|---|---|---|
| `main` branch | Active development (pre-mainnet) | ✅ Yes |
| `v1.x` (testnet demo line) | Latest only | ✅ Yes |

`agenticzk-mcp` is the MCP server for **[AgenticZK](https://github.com/0xAiBRN/agenticzk)**, a testnet-only Agentic + ZK + fully-on-chain research demo. All deployments it targets are **testnet-only — no real funds are at risk** (testnet USDC = valueless faucet tokens). See the main repo's [`DISCLAIMER.md`](https://github.com/0xAiBRN/agenticzk/blob/main/DISCLAIMER.md) and this repo's [`DISCLAIMER.md`](DISCLAIMER.md).

## Disclosure Policy

Coordinated disclosure:

- **90-day** maximum between report and public disclosure (industry standard)
- Reporter is credited in the security advisory unless anonymity is requested

## Known constraints (NOT vulnerabilities)

These are **documented and accepted** for the current testnet phase. Please do not file reports for them:

1. **Testnet-only.** The server targets the Arc testnet (chainId `5042002`). Testnet USDC is a valueless faucet token; there is no real-money loss vector.
2. **Single-party ZK trusted setup.** The `.zkey` artifacts the poker prover tools consume come from a single-party Powers of Tau ceremony (development / testnet only) and are **not safe for mainnet** by design. See the main repo's `docs/CEREMONY_OUTREACH.md`.
3. **The signer is your responsibility.** This MCP returns unsigned txs; the wallet/harness that signs them (e.g. `scripts/register-eip3009.ts`) holds your key and enforces its own tx-whitelist. Key management is out of this server's scope.
4. **No bug-bounty program yet.** A formal program will be announced before any mainnet step.

## In Scope

- MCP tool handlers — `mcp-server/src/tools/**`
- Shared helpers — `mcp-server/src/{config,chains,errors,validate,resolve-orchestrator,poker-abis,protocol-knowledge}.ts`
- Server entry + tool registration — `mcp-server/src/index.ts`
- CI configuration — `.github/workflows/**`

## Out of Scope

- Testnet-only fund loss
- Denial-of-service via excessive RPC use (rate-limit your own provider)
- Dependency vulnerabilities → use the [Dependabot alerts](https://github.com/0xAiBRN/agenticzk-mcp/security/dependabot) channel
- AI model misbehavior (an agent makes a bad bet) — agent strategy is the operator's responsibility
- The wallet/harness that signs the unsigned txs (a separate component that holds your key)

## License

This repository is licensed under **Apache-2.0** — see [`LICENSE`](LICENSE). Note that two runtime ZK dependencies (`snarkjs`, `circomlibjs`) are **GPL-3.0** npm libraries used by the shuffle/decrypt prover tools — see [`NOTICE`](NOTICE).

---

**Last updated:** 2026-07-01
