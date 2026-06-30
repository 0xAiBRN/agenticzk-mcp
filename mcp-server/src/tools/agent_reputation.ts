import { encodeFunctionData } from "viem";
import { config } from "../config.js";
import { ReputationRegistryAbi } from "../chains.js";
import { okResult, errorResult, err } from "../errors.js";
import { keccak256, stringToHex } from "viem";
import { validateAddress } from "../validate.js";

export async function agentReputationHandler(args: {
  action: string;
  agentId: string;
  reviewer?: string;
  score?: number;
  feedbackType?: number;
  tag?: string;
  comment?: string;
}) {
  const { action, agentId } = args;

  if (action === "give") {
    const score = args.score ?? 100;
    const feedbackType = args.feedbackType ?? 0;
    const tag = args.tag ?? "general";
    const comment = args.comment ?? "";

    // audit 2026-05-22 MC-09 — reviewer adresi runtime'da doğrula.
    const reviewer = validateAddress(args.reviewer);
    if (!reviewer) {
      return errorResult(err("E_INVALID_ADDRESS", "reviewer must be a valid 0x-prefixed 20-byte address"));
    }

    // audit 2026-05-22 MC-10 — BigInt(agentId/score) try/catch'siz unhandled
    // exception riski (MCP process crash).
    let agentIdBig: bigint;
    let scoreBig: bigint;
    try {
      agentIdBig = BigInt(agentId);
      scoreBig = BigInt(score);
    } catch (e) {
      return errorResult(err("E_INVALID_NUMBER", `agentId/score must be numeric: ${(e as Error).message}`));
    }

    const feedbackHash = keccak256(stringToHex(`${agentId}-${score}-${Date.now()}`));

    const data = encodeFunctionData({
      abi: ReputationRegistryAbi,
      functionName: "giveFeedback",
      args: [
        agentIdBig,
        scoreBig,
        feedbackType,
        tag,
        "",  // metadataURI
        "",  // evidenceURI
        comment,
        feedbackHash,
      ],
    });

    return okResult({
      unsignedTx: {
        to: config.reputationRegistry,
        data,
        value: "0",
        chainId: config.arcChainId,
      },
      reviewer,
      agentId,
      score,
      tag,
      note: "Reviewer must differ from agent owner (no self-rating).",
    });
  }

  return errorResult(err("E_INVALID_ACTION", "Action must be 'give'. Read queries coming soon."));
}
