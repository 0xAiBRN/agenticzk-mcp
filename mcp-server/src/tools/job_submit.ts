import { encodeFunctionData, keccak256, stringToHex } from "viem";
import { config } from "../config.js";
import { ERC8183Abi } from "../chains.js";
import { okResult, errorResult, err } from "../errors.js";
import { validateAddress } from "../validate.js";

export async function jobSubmitHandler(args: {
  provider: string;
  jobId: string;
  deliverable: string;
}) {
  // audit 2026-05-22 MC-09 — runtime adres doğrulama.
  const provider = validateAddress(args.provider);
  if (!provider) {
    return errorResult(err("E_INVALID_ADDRESS", "provider must be a valid 0x-prefixed 20-byte address"));
  }
  // audit 2026-05-22 MC-10 — BigInt(jobId) try/catch.
  let jobId: bigint;
  try {
    jobId = BigInt(args.jobId);
  } catch (e) {
    return errorResult(err("E_INVALID_JOB_ID", `jobId must be numeric: ${(e as Error).message}`));
  }
  const { deliverable } = args;

  if (!deliverable || deliverable.length === 0) {
    return errorResult(err("E_EMPTY_DELIVERABLE", "Deliverable description cannot be empty"));
  }

  // Hash the deliverable content — on-chain stores only the hash
  const deliverableHash = keccak256(stringToHex(deliverable));

  const data = encodeFunctionData({
    abi: ERC8183Abi,
    functionName: "submit",
    args: [jobId, deliverableHash, "0x"],
  });

  return okResult({
    unsignedTx: {
      to: config.erc8183,
      data,
      value: "0",
      chainId: config.arcChainId,
    },
    provider,
    jobId: jobId.toString(),
    deliverableHash,
    deliverablePreview: deliverable.slice(0, 200),
    note: "Deliverable hash submitted. Evaluator can now call job_complete.",
  });
}
