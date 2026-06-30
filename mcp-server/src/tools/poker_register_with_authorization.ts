// poker_register_with_authorization — Path B EIP-3009 register entry point (FIX-1, 2026-06-22).
//
// WHY THIS EXISTS: on a public-USDC tournament the orchestrator sets
// isPublicUsdcOnly()==true, which DISABLES depositFor — so the legacy
// poker_register_for_tournament 3-step chain reverts DepositForDisabledForPublicUsdc
// at step 2 and strands the entry fee. The ONLY working register is the atomic
// EIP-3009 registerWithAuthorization (selector 0xb704dd06). A pure-MCP harness had
// no way to reach it, so a Path B (Claude Code / Codex CLI) user could not register.
//
// PK-SAFETY (the MCP signs NOTHING): registerWithAuthorization embeds a SIGNED
// EIP-3009 ReceiveWithAuthorization (v,r,s) in its calldata, which requires the
// player's private key. The MCP never holds a key, so it CANNOT build the final
// calldata. Instead this tool returns a RECIPE (public, deterministic facts +
// preflight results) and points the user at the harness signer
// scripts/register-eip3009.ts, which (1) signs the EIP-3009 typed-data and
// (2) signs + broadcasts the outer tx. No v/r/s and no final calldata ever leave
// the MCP.

import { parseUnits, parseAbi } from "viem";
import { config } from "../config.js";
import { PokerOrchestratorAbi } from "../poker-abis.js";
import { resolveActiveOrchestrator } from "../resolve-orchestrator.js";
import { okResult, errorResult, err } from "../errors.js";
import { validateAddress } from "../validate.js";
import { readContractWithRetry } from "../chains.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const IDENTITY_OWNEROF_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
]);

export async function pokerRegisterWithAuthorizationHandler(args: {
  player: string;
  tournamentId: string;
  agentId: string;
  entryFeeUsdc?: string;
}) {
  const player = validateAddress(args.player);
  if (!player) {
    return errorResult(err("E_INVALID_ADDRESS", "player must be a valid 0x-prefixed 20-byte address"));
  }
  if (player === ZERO) {
    return errorResult(err("E_INVALID_PLAYER", "player address cannot be zero"));
  }
  const tournamentId = args.tournamentId as `0x${string}`;
  if (!tournamentId || !tournamentId.startsWith("0x") || tournamentId.length !== 66) {
    return errorResult(err("E_INVALID_TOURNAMENT_ID", "tournamentId must be a 0x-prefixed 32-byte hex string"));
  }
  let agentId: bigint;
  try {
    agentId = BigInt(args.agentId);
  } catch {
    return errorResult(err("E_INVALID_AGENT_ID", "agentId must be a numeric string"));
  }
  if (agentId <= 0n) {
    return errorResult(err("E_INVALID_AGENT_ID", "agentId must be positive"));
  }

  let fallbackFee: bigint;
  try {
    fallbackFee = parseUnits(args.entryFeeUsdc ?? "1.00", 6);
  } catch (e) {
    return errorResult(err("E_INVALID_ENTRY_FEE", `entryFeeUsdc must be a numeric string: ${(e as Error).message}`));
  }

  // ── Preflight reads (best-effort) ────────────────────────────────────────
  // On a definitive bad result we return a clean MCP error so the user never
  // wastes a tx; on an RPC read failure we fall through (the contract still
  // enforces every condition on broadcast — mirrors poker_expire_action).
  const preflight: Record<string, unknown> = {};
  let entryFeeRaw = fallbackFee;
  let entryFeeSource = "arg-or-default";

  // Resolve the canonical orchestrator (drift-proof) — the SAME resolution
  // poker_discover_open_tournaments and poker_tournament_state use, so a
  // tournament discovered via the registry-resolved address is registered
  // against the same address (no discovery<->register mismatch on stale env).
  const resolved = await resolveActiveOrchestrator();
  const orchestrator = resolved.orchestrator;

  try {
    const t = (await readContractWithRetry({
      address: orchestrator,
      abi: PokerOrchestratorAbi,
      functionName: "tournamentOf",
      args: [tournamentId],
    })) as readonly [
      `0x${string}`, `0x${string}`, bigint, number, number, number, number, bigint,
    ];
    const [creator, token, onChainFee, , maxPlayers, registered, phase] = t;
    if (creator === ZERO) {
      return errorResult(
        err(
          "E_TOURNAMENT_NOT_FOUND",
          `Tournament ${tournamentId} not found on orchestrator ${orchestrator} (creator=0). ` +
            `Most common cause: a STALE POKER_ORCHESTRATOR address after a redeploy, or a wrong tournamentId.`,
        ),
      );
    }
    // Phase enum is { Draft=0, Registering=1, Running=2, Finalized=3, Cancelled=4 }
    // and the contract's register/registerWithAuthorization require
    // phase == Registering (1). The old check rejected everything except Draft
    // (phase==0), i.e. it blocked every valid open tournament — only masked when
    // the preflight read failed into the non-fatal catch below.
    if (phase !== 1) {
      return errorResult(
        err("E_WRONG_PHASE", `Tournament phase=${phase} (Registering=1 required) — registration is not open.`, {
          phase,
        }),
      );
    }
    if (registered >= maxPlayers) {
      return errorResult(
        err("E_LOBBY_FULL", `Tournament is full (${registered}/${maxPlayers}).`, { registered, maxPlayers }),
      );
    }
    // The contract enforces value == tournament.entryFee; use the on-chain value
    // as authoritative so a wrong entryFeeUsdc arg cannot produce a tx that reverts
    // AuthorizationValueMismatch.
    entryFeeRaw = onChainFee;
    entryFeeSource = "on-chain tournamentOf.entryFee";
    preflight.tournament = {
      token,
      tokenIsUsdc: token.toLowerCase() === config.usdc.toLowerCase(),
      registered,
      maxPlayers,
      phase,
    };
  } catch (e) {
    preflight.tournament = `read failed (non-fatal, contract still enforces on broadcast): ${(e as Error).message.slice(0, 120)}`;
  }

  try {
    const already = (await readContractWithRetry({
      address: orchestrator,
      abi: PokerOrchestratorAbi,
      functionName: "isOwnerRegistered",
      args: [tournamentId, player],
    })) as boolean;
    if (already) {
      return errorResult(
        err("E_OWNER_ALREADY_REGISTERED", `Wallet ${player} already holds a seat in this tournament — nothing to do.`),
      );
    }
    preflight.ownerRegistered = false;
  } catch (e) {
    preflight.ownerRegistered = `read failed (non-fatal): ${(e as Error).message.slice(0, 120)}`;
  }

  try {
    const owner = (await readContractWithRetry({
      address: config.identityRegistry,
      abi: IDENTITY_OWNEROF_ABI,
      functionName: "ownerOf",
      args: [agentId],
    })) as `0x${string}`;
    if (owner.toLowerCase() !== player.toLowerCase()) {
      return errorResult(
        err(
          "E_AGENT_NOT_OWNED",
          `IdentityRegistry.ownerOf(${agentId})=${owner} != player ${player}. ` +
            `The agent NFT must be owned by the registering wallet (mint one via scripts/register-eip3009.ts if you have none).`,
          { owner, player },
        ),
      );
    }
    preflight.agentOwned = true;
  } catch (e) {
    // ownerOf reverts for a non-existent tokenId — the signer will mint one.
    preflight.agentOwned = `read failed / token may not exist yet (signer will mint): ${(e as Error).message.slice(0, 120)}`;
  }

  return okResult({
    player,
    tournamentId,
    agentId: agentId.toString(),
    orchestrator,
    orchestratorSource: resolved.source,
    chainId: config.arcChainId,
    register: {
      method: "EIP-3009 registerWithAuthorization (atomic single tx — the only working path on public-USDC tournaments)",
      usdcToken: config.usdc,
      value: entryFeeRaw.toString(),
      valueSource: entryFeeSource,
      functionName: "registerWithAuthorization",
      selector: "0xb704dd06",
      argsOrder: [
        "tournamentId",
        "agentId",
        "value",
        "validAfter",
        "validBefore",
        "nonce",
        "v",
        "r",
        "s",
      ],
    },
    preflight,
    // Fee disclosure (HC#11) — mirror poker_register_for_tournament so a Path B
    // user sees the rake before authorizing funds.
    feeDisclosure: {
      protocolRakeBps: 200,
      breakdown: { houseRakeBps: 100, organizerRakeBps: 100 },
      takenAt: "finalize-only",
      appliesTo: "prize pool (winnings are paid net of the 2% rake)",
      refundable: "full entry fee is refundable if the tournament is cancelled or abandoned (no rake on refunds)",
      summary:
        "2% protocol rake (1% house + 1% organizer) is deducted from the prize pool at finalize only; your entry fee is escrowed on register and fully refundable on cancel/abandon.",
    },
    signer: {
      pkSafety:
        "This MCP tool returns NO signature and NO final calldata — it cannot. registerWithAuthorization embeds an EIP-3009 signature (v,r,s) that requires YOUR private key, which the MCP never holds.",
      howTo:
        "Run the harness signer that holds PLAYER_PK: `pnpm --filter @agenticzk/agent-runner exec tsx scripts/register-eip3009.ts`. With PLAYER_PK + TOURNAMENT_ID + AGENT_ID (+ contract addresses) in your env, it (1) mints an ERC-8004 identity NFT if you have none, (2) signs the EIP-3009 ReceiveWithAuthorization typed-data reading the live USDC domain, then (3) signs + broadcasts the registerWithAuthorization tx (whitelist-defended, native value capped at 0).",
    },
    note:
      "DO NOT call poker_register_for_tournament on a public-USDC tournament — its depositFor step reverts (DepositForDisabledForPublicUsdc) and your raw USDC transfer would strand unrecoverably. This is the correct entry point.",
  });
}
