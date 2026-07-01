# AgenticZK MCP — Disclaimer & Positioning

> **Read this first.** This document defines what `agenticzk-mcp` is — and, just
> as importantly, what it is **not**.

> ## ⚠️ Purpose & scope — please read
>
> AgenticZK (and this MCP server) exists **purely for entertainment, experimentation,
> and to demonstrate a technical vision**. Concretely and without exception:
>
> - **Testnet only**, using **valueless test tokens** (Arc testnet faucet USDC with **no
>   monetary value**).
> - **Not** a gambling, financial, money-transmission, or investment product; it handles
>   **no real funds** (and this server **signs nothing** — see below).
> - **It will NOT be run on any mainnet, and will not touch any real-value assets, unless
>   and until the relevant legal and regulatory processes have been properly reviewed and
>   satisfied** — a step explicitly **gated on qualified legal counsel** and **not promised**.
> - The whole exercise is a **vision + fun** proof-of-concept, not a real-money product.

## What this is

`agenticzk-mcp` is the **MCP server** for **[AgenticZK](https://github.com/0xAiBRN/agenticzk)**,
a **testnet-only research demo** that combines **Agentic + Zero-Knowledge +
fully-on-chain** layers on the **Arc** ecosystem. This server wraps Arc's agent
primitives — ERC-8004 identity, ERC-8183 escrowed jobs, a read-only balance view,
and the on-chain ZK "mental poker" Texas Hold'em engine — in **51 MCP tools** so
any AI client (Claude, Cursor, ChatGPT) can participate.

**For fun and testing.** It is an engineering proof-of-concept, not a product.

## It signs nothing

Every state-changing tool returns an **unsigned transaction** that your own
wallet/harness signs. This MCP never holds a wallet private key. The only secret
it reads is `PLAYER_SESSION_SEED` (a ZK decrypt seed that **cannot move funds**).
The standalone Circle money tools (`send_token` / `bridge_send` / `nano_*`) that
once signed with a wallet key were **removed 2026-06-13**. See [`SECURITY.md`](SECURITY.md).

## TESTNET ONLY — no real money

- The tools target **only the Arc testnet** (chainId `5042002`).
- All value is **testnet USDC** — **valueless faucet tokens**, not real money.
- The engine's **rake** (a small per-hand mechanic, applied contract-side in the
  main repo) operates on these **valueless testnet tokens** purely to exercise the
  full tournament flow. It is **not** a real-money commission.

## What is NOT here (planned for a possible V2)

- **No economic or collectible NFTs.** The only NFT AgenticZK mints is the
  **ERC-8004 agent identity NFT** — a testnet, non-transferable-in-spirit identity
  token. There is **no reward / collectible / tradeable NFT**; the meme-token +
  rake-distribution economics are a *possible* future V2, **not** implemented or live.
- **No mainnet.** There is **no mainnet deployment and no mainnet target** without a
  **prior, serious legal review** (regulatory classification, licensing,
  jurisdiction). Any future real-money / mainnet step is explicitly **gated on legal
  counsel** and is **not** promised.

## Not advice, no warranty

- This is **not** gambling-, financial-, investment-, or legal advice.
- Provided **as-is, no warranty** (see [`LICENSE`](LICENSE), Apache-2.0).
- The ZK trusted-setup is currently **single-party (testnet only)** and is **not**
  claimed to be "provably fair" — a multi-party ceremony is required before any
  soundness guarantee. This is stated honestly and is a known pre-mainnet item.

---

*AgenticZK · solo-builder research demo · Arc testnet · for feasibility, fun & testing.*
