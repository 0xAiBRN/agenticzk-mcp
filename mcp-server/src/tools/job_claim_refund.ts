import { encodeFunctionData } from "viem";
import { config } from "../config.js";
import { ERC8183Abi } from "../chains.js";
import { okResult, errorResult, err } from "../errors.js";
import { validateAddress } from "../validate.js";

export async function jobClaimRefundHandler(args: {
  client: string;
  jobId: string;
}) {
  // audit 2026-05-22 MC-09 — runtime adres doğrulama.
  const client = validateAddress(args.client);
  if (!client) {
    return errorResult(err("E_INVALID_ADDRESS", "client must be a valid 0x-prefixed 20-byte address"));
  }
  // audit 2026-05-22 MC-10 — BigInt(jobId) try/catch (MCP crash önle).
  let jobId: bigint;
  try {
    jobId = BigInt(args.jobId);
  } catch (e) {
    return errorResult(err("E_INVALID_JOB_ID", `jobId must be numeric: ${(e as Error).message}`));
  }

  const data = encodeFunctionData({
    abi: ERC8183Abi,
    functionName: "claimRefund",
    args: [jobId],
  });

  return okResult({
    unsignedTx: {
      to: config.erc8183,
      data,
      value: "0",
      chainId: config.arcChainId,
    },
    client,
    jobId: jobId.toString(),
    note: "Use for Expired jobs only. Rejected jobs auto-refund; calling here reverts.",
  });
}
