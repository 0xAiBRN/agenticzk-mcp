import { encodeFunctionData, keccak256, stringToHex } from "viem";
import { config } from "../config.js";
import { ERC8183Abi } from "../chains.js";
import { okResult, errorResult, err } from "../errors.js";
import { validateAddress } from "../validate.js";

export async function jobCompleteHandler(args: {
  evaluator: string;
  jobId: string;
  reason?: string;
}) {
  // audit 2026-05-22 MC-09 — runtime adres doğrulama.
  const evaluator = validateAddress(args.evaluator);
  if (!evaluator) {
    return errorResult(err("E_INVALID_ADDRESS", "evaluator must be a valid 0x-prefixed 20-byte address"));
  }
  // audit 2026-05-22 MC-10 — BigInt(jobId) try/catch.
  let jobId: bigint;
  try {
    jobId = BigInt(args.jobId);
  } catch (e) {
    return errorResult(err("E_INVALID_JOB_ID", `jobId must be numeric: ${(e as Error).message}`));
  }
  const reason = args.reason ?? "approved";
  const reasonHash = keccak256(stringToHex(reason));

  const data = encodeFunctionData({
    abi: ERC8183Abi,
    functionName: "complete",
    args: [jobId, reasonHash, "0x"],
  });

  return okResult({
    unsignedTx: {
      to: config.erc8183,
      data,
      value: "0",
      chainId: config.arcChainId,
    },
    evaluator,
    jobId: jobId.toString(),
    reasonHash,
    note: "Approve deliverable and release payment.",
  });
}
