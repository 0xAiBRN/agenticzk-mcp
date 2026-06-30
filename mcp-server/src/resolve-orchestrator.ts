import type { Address } from "viem";
import { readContractWithRetry } from "./chains.js";
import { config } from "./config.js";
import { ProtocolRegistryAbi } from "./poker-abis.js";

// Drift-proof orchestrator resolution shared by discovery + register + state.
//
// The configured POKER_ORCHESTRATOR (env, synced from latest.json) is normally
// correct, but a redeploy that updated the on-chain ProtocolRegistry without a
// local re-sync would leave it stale. Reading the canonical orchestrator from
// ProtocolRegistry.getActiveRelease() keeps every consumer pointed at the SAME
// address, so discovery can never surface a tournament that register/state then
// look for on a different (stale) orchestrator. Falls back to the env address
// when the registry is unset or unreadable (behaviour unchanged from before).
//
// Read-only — signs nothing.

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export interface ResolvedOrchestrator {
  orchestrator: Address;
  canonicalTableSystem: Address | null;
  semver: string | null;
  source: "registry" | "env";
  warnings: string[];
}

export async function resolveActiveOrchestrator(): Promise<ResolvedOrchestrator> {
  const warnings: string[] = [];
  const envOrchestrator = config.pokerOrchestrator as Address;

  if (!config.protocolRegistry) {
    warnings.push(
      "POKER_PROTOCOL_REGISTRY not set — using configured orchestrator (cannot verify canonical version).",
    );
    return { orchestrator: envOrchestrator, canonicalTableSystem: null, semver: null, source: "env", warnings };
  }

  try {
    const release = (await readContractWithRetry({
      address: config.protocolRegistry,
      abi: ProtocolRegistryAbi,
      functionName: "getActiveRelease",
    })) as { semver: string; tournamentOrchestrator: Address; tableSystem: Address };

    if (release?.tournamentOrchestrator && release.tournamentOrchestrator !== ZERO_ADDR) {
      if (release.tournamentOrchestrator.toLowerCase() !== envOrchestrator.toLowerCase()) {
        warnings.push(
          `configured POKER_ORCHESTRATOR (${envOrchestrator}) differs from the registry's active orchestrator (${release.tournamentOrchestrator}); using the registry's.`,
        );
      }
      return {
        orchestrator: release.tournamentOrchestrator,
        canonicalTableSystem: release.tableSystem,
        semver: release.semver,
        source: "registry",
        warnings,
      };
    }
  } catch (e) {
    warnings.push(
      `ProtocolRegistry.getActiveRelease() read failed; using configured orchestrator (not drift-proof): ${(e as Error).message.slice(0, 100)}`,
    );
  }
  return { orchestrator: envOrchestrator, canonicalTableSystem: null, semver: null, source: "env", warnings };
}
