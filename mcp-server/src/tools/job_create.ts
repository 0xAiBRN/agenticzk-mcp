import { encodeFunctionData } from "viem";
import { config } from "../config.js";
import { ERC8183Abi } from "../chains.js";
import { okResult, errorResult, err } from "../errors.js";
import { validateAddress } from "../validate.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export async function jobCreateHandler(args: {
  client: string;
  provider: string;
  evaluator?: string;
  description: string;
  deadlineMinutes?: number;
}) {
  // audit 2026-05-22 MC-09 — client/provider/evaluator runtime adres guard.
  const client = validateAddress(args.client);
  if (!client) {
    return errorResult(err("E_INVALID_ADDRESS", "client must be a valid 0x-prefixed 20-byte address"));
  }
  const provider = validateAddress(args.provider);
  if (!provider) {
    return errorResult(err("E_INVALID_ADDRESS", "provider must be a valid 0x-prefixed 20-byte address"));
  }
  const evaluator = args.evaluator ? validateAddress(args.evaluator) : client; // Default: client is evaluator
  if (!evaluator) {
    return errorResult(err("E_INVALID_ADDRESS", "evaluator must be a valid 0x-prefixed 20-byte address"));
  }
  const { description } = args;

  if (client === ZERO_ADDRESS) {
    return errorResult(err("E_INVALID_CLIENT", "Client address cannot be zero"));
  }
  if (provider === ZERO_ADDRESS) {
    return errorResult(err("E_INVALID_PROVIDER", "Provider address cannot be zero"));
  }
  if (!description || description.length === 0) {
    return errorResult(err("E_EMPTY_DESCRIPTION", "Job description cannot be empty"));
  }

  // Default 24h deadline, min 15 min, max 30 days
  const deadlineMinutes = args.deadlineMinutes ?? 1440;
  const clampedMinutes = Math.max(15, Math.min(deadlineMinutes, 43200));
  const expiredAt = BigInt(Math.floor(Date.now() / 1000) + clampedMinutes * 60);

  const data = encodeFunctionData({
    abi: ERC8183Abi,
    functionName: "createJob",
    args: [provider, evaluator, expiredAt, description, ZERO_ADDRESS],
  });

  return okResult({
    unsignedTx: {
      to: config.erc8183,
      data,
      value: "0",
      chainId: config.arcChainId,
    },
    client,
    provider,
    evaluator,
    description,
    expiredAt: expiredAt.toString(),
    deadlineMinutes: clampedMinutes,
    note: "Extract jobId from JobCreated event. Provider calls job_set_budget next.",
  });
}
