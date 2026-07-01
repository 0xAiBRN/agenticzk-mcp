# Contributing to AgenticZK MCP

Thanks for your interest. `agenticzk-mcp` is the **MCP server** for
**[AgenticZK](https://github.com/0xAiBRN/agenticzk)** — a testnet-only Agentic +
ZK + fully-on-chain research demo (see [`DISCLAIMER.md`](DISCLAIMER.md)). This
server is **unsigned-by-design**: every tool returns an *unsigned* transaction
your own wallet/harness signs. Contributions that keep it that way are welcome.

> **Before anything else:** read [`SECURITY.md`](SECURITY.md) for vulnerability
> reporting (use Private Vulnerability Reporting, **not** public issues), and
> [`LICENSE`](LICENSE) — this project is **Apache-2.0**. Contributions are accepted
> under the same license.

## The one rule that overrides everything: the MCP signs nothing

- Tools return **unsigned** transactions (calldata or a recipe + preflight). Never
  add a code path that reads a wallet private key or broadcasts a signed tx.
- The only secret the server may read is `PLAYER_SESSION_SEED` (a ZK decrypt seed
  that cannot move funds), and only from **env**, never a tool argument.
- A PR that reintroduces a key-signing "move my money" tool (the class removed
  2026-06-13) will be rejected by design.

## What I'm accepting

| Type | Welcome | Notes |
|---|---|---|
| Bug reports | ✅ | Use GitHub Issues. Include repro steps + environment. |
| Security findings | ✅ | **Do not** open a public issue — use PVR (see `SECURITY.md`). |
| Documentation fixes | ✅ | Typos, broken links, clearer tool descriptions — small PRs welcome. |
| Test additions | ✅ | Especially: tool preflight tests, ZK glue (canonical-deck / commitment) regressions. |
| Bug fixes | ✅ | Open an issue first if scope is unclear. |
| New tools / features | ⚠️ | Open an issue first. Must stay unsigned-by-design and align with the main repo's hard constraints (fully on-chain, zero-server, AI-agent-first, Arc-only). |

## Development setup

```bash
git clone https://github.com/0xAiBRN/agenticzk-mcp.git
cd agenticzk-mcp/mcp-server
pnpm install
pnpm run build      # tsc
pnpm run test       # node:test harness (ZK glue)
```

The ZK prover tools also need the circuits `build/` directory from the main repo —
set `ZK_ARTIFACTS_DIR` (see [`mcp-server/.env.example`](mcp-server/.env.example)).

## Pull request checklist

Before opening a PR, run these in `mcp-server/` and report results in the PR body:

- [ ] `npx tsc --noEmit` — TypeScript clean, zero errors
- [ ] `pnpm run build` — clean
- [ ] `pnpm run test` — all tests pass
- [ ] No `.env` / wallet key / seed staged (`mcp-server/.env` is a symlink to a personal secrets dir)
- [ ] No absolute home paths in tracked files (CI `hygiene` job enforces this)
- [ ] Tool count in `README.md` still matches the `server.tool(` registrations in `index.ts`

## Commit style

Conventional Commits:

```
<type>(<scope>): <subject>
```

- **type:** `feat` | `fix` | `docs` | `refactor` | `test` | `chore` | `perf` | `audit`
- **scope:** optional, kebab-case (e.g. `mcp`, `zk`, `register`, `liveness`)
- **body:** explain *why*, not what

## AI-agent disclosure

This repository is built collaboratively with AI agents (Claude Code, Codex CLI).
If you used an AI assistant for your contribution, **include a `Co-Authored-By:`
footer** in your commit message. Example:

```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

## Code style

- **TypeScript:** strict mode on; no `any` without justification; **never `console.log`** in a tool (it corrupts the JSON-RPC stdio pipe — use `process.stderr.write`).
- **Comments:** explain *why*, not *what*. Don't reference PRs or task IDs in code comments — they belong in commit messages.

## License of contributions

By submitting a contribution, you agree it is licensed under **Apache-2.0** (this
project's license). No CLA is required — this is a single-author project at this
stage.

---

**Last updated:** 2026-07-01
