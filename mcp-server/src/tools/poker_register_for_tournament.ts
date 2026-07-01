import { encodeFunctionData, parseUnits } from "viem";
import { config } from "../config.js";
import { PokerOrchestratorAbi } from "../poker-abis.js";
import { ERC20Abi, readContractWithRetry } from "../chains.js";
import { resolveActiveOrchestrator } from "../resolve-orchestrator.js";
import { okResult, errorResult, err } from "../errors.js";
import { validateAddress } from "../validate.js";

export async function pokerRegisterForTournamentHandler(args: {
  player: string;
  tournamentId: string;
  agentId: string;
  entryFeeUsdc?: string;
}) {
  // audit 2026-05-22 MC-09 — runtime adres doğrulama.
  const player = validateAddress(args.player);
  if (!player) {
    return errorResult(err("E_INVALID_ADDRESS", "player must be a valid 0x-prefixed 20-byte address"));
  }
  const tournamentId = args.tournamentId as `0x${string}`;

  if (player === "0x0000000000000000000000000000000000000000") {
    return errorResult(err("E_INVALID_PLAYER", "player address cannot be zero"));
  }
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

  // audit 2026-05-22 MC-10 — parseUnits try/catch (geçersiz numeric MCP crash).
  let entryFee: bigint;
  try {
    entryFee = parseUnits(args.entryFeeUsdc ?? "1.00", 6);
  } catch (e) {
    return errorResult(err("E_INVALID_ENTRY_FEE", `entryFeeUsdc must be a numeric string: ${(e as Error).message}`));
  }

  // Resolve the canonical orchestrator (drift-proof) — the SAME resolution
  // poker_register_with_authorization / poker_discover_open_tournaments /
  // poker_tournament_state use. Reads ProtocolRegistry.getActiveRelease() when a
  // registry is configured, else falls back to the env POKER_ORCHESTRATOR. This
  // keeps both register paths (3-step + EIP-3009) targeting the same active/gated
  // orchestrator, so a stale env address can never split them. Read-only.
  const resolved = await resolveActiveOrchestrator();
  const orchestrator = resolved.orchestrator;

  // 2026-06-22 (Path B build, FIX-1) — FAIL-CLOSED public-USDC gate. On a
  // public-USDC tournament the orchestrator disables depositFor; the 3-step
  // chain below would then revert at step 2 (DepositForDisabledForPublicUsdc)
  // AFTER the user already broadcast step 1's raw USDC.transfer, stranding the
  // entry fee unrecoverably (no pendingDeposit slot is credited). Refuse here
  // and point at the EIP-3009 entry point. We fail CLOSED (refuse on read error
  // too): the dominant deployment is public, and a wrong fall-through burns real
  // funds. Local MockERC20 / CHIP dev (isPublicUsdcOnly==false) is unaffected.
  try {
    const publicUsdcOnly = (await readContractWithRetry({
      address: orchestrator,
      abi: PokerOrchestratorAbi,
      functionName: "isPublicUsdcOnly",
      args: [],
    })) as boolean;
    if (publicUsdcOnly) {
      return errorResult(
        err(
          "E_DEPOSITFOR_DISABLED",
          "This orchestrator is public-USDC-only: depositFor is disabled, so the transfer→depositFor→register chain " +
            "would revert at step 2 and STRAND your entry fee. Use poker_register_with_authorization (EIP-3009 atomic " +
            "register) instead — it is the only working register path here.",
        ),
      );
    }
  } catch (e) {
    return errorResult(
      err(
        "E_GATE_READ_FAILED",
        `Could not read isPublicUsdcOnly() to confirm this register path is safe (${(e as Error).message.slice(0, 120)}). ` +
          "Refusing fail-closed — if this is a public-USDC tournament the legacy chain would strand your entry fee. " +
          "Use poker_register_with_authorization, or retry when the RPC is healthy.",
      ),
    );
  }

  // MCP1 (audit 2026-05-08) — switch from the legacy 2-step approve+register
  // flow to the H2 3-step pre-pay chain that mitigates Arc Bug 1
  // (`transferFrom` contract-spender StackUnderflow precompile bug).
  // Sequence:
  //   1. caller direct USDC.transfer(orchestrator, fee)  — msg.sender == EOA, bypasses Bug 1
  //   2. orchestrator.depositFor(tournamentId, agentId, fee) — credits depositor-bound slot
  //   3. orchestrator.register(tournamentId, agentId) — consumes pendingDeposit, no transferFrom
  //
  // The agent runner has the H2.5 atomic alternative (`registerWithAuthorization`,
  // single tx via EIP-3009) that smoke-arc-*-brain.ts uses; this MCP path
  // is the chain-neutral 3-step variant for harnesses that don't sign EIP-3009
  // typed-data and for tokens without that surface (e.g. CHIP).
  const transferData = encodeFunctionData({
    abi: ERC20Abi,
    functionName: "transfer",
    args: [orchestrator, entryFee],
  });

  const depositForData = encodeFunctionData({
    abi: PokerOrchestratorAbi,
    functionName: "depositFor",
    args: [tournamentId, agentId, entryFee],
  });

  const registerData = encodeFunctionData({
    abi: PokerOrchestratorAbi,
    functionName: "register",
    args: [tournamentId, agentId],
  });

  return okResult({
    unsignedTxs: [
      {
        step: 1,
        purpose: "USDC transfer (caller → orchestrator, Bug 1 bypass)",
        to: config.usdc,
        data: transferData,
        value: "0",
        chainId: config.arcChainId,
      },
      {
        step: 2,
        purpose: "Orchestrator depositFor (credit depositor-bound slot)",
        to: orchestrator,
        data: depositForData,
        value: "0",
        chainId: config.arcChainId,
      },
      {
        step: 3,
        purpose: "Tournament register (consumes pendingDeposit)",
        to: orchestrator,
        data: registerData,
        value: "0",
        chainId: config.arcChainId,
      },
    ],
    player,
    tournamentId,
    agentId: agentId.toString(),
    orchestrator,
    orchestratorSource: resolved.source,
    entryFeeUsdc: args.entryFeeUsdc ?? "1.00",
    entryFeeRaw: entryFee.toString(),
    // Fee disclosure (hard-audit 2026-06-12 M4 / HC#11) — the MCP "Yol B" onboarding
    // path never runs agent.ts (which had the only discloseFees), so the primary
    // user was charged the rake with zero disclosure. Surface it in the payload too.
    feeDisclosure: {
      protocolRakeBps: 200,
      breakdown: { houseRakeBps: 100, organizerRakeBps: 100 },
      takenAt: "finalize-only",
      appliesTo: "prize pool (winnings are paid net of the 2% rake)",
      refundable: "full entry fee is refundable if the tournament is cancelled or abandoned (no rake on refunds)",
      summary: "2% protocol rake (1% house + 1% organizer) is deducted from the prize pool at finalize only; your entry fee is escrowed on register and fully refundable on cancel/abandon.",
    },
    note: "Sign step 1, 2, 3 in order. All three must land before registration is complete. Step 1 is a direct transfer (caller is EOA → Arc Bug 1 bypass). Step 2 credits the depositor-bound slot; step 3 consumes it.",
  });
}
