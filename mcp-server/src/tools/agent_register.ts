import { encodeFunctionData } from "viem";
import { config } from "../config.js";
import { IdentityRegistryAbi } from "../chains.js";
import { okResult, errorResult, err } from "../errors.js";
import { validateAddress } from "../validate.js";

export async function agentRegisterHandler(args: {
  owner: string;
  metadataURI: string;
}) {
  // audit 2026-05-22 MC-09 — validateAddress runtime'da hex+length+checksum guard.
  const owner = validateAddress(args.owner);
  if (!owner) {
    return errorResult(err("E_INVALID_ADDRESS", "owner must be a valid 0x-prefixed 20-byte address"));
  }
  const { metadataURI } = args;

  if (owner === "0x0000000000000000000000000000000000000000") {
    return errorResult(err("E_INVALID_OWNER", "Owner address cannot be zero"));
  }
  if (!metadataURI || metadataURI.length === 0) {
    return errorResult(err("E_INVALID_URI", "Metadata URI cannot be empty"));
  }

  const data = encodeFunctionData({
    abi: IdentityRegistryAbi,
    functionName: "register",
    args: [metadataURI],
  });

  return okResult({
    unsignedTx: {
      to: config.identityRegistry,
      data,
      value: "0",
      chainId: config.arcChainId,
    },
    owner,
    metadataURI,
    note: "Mint identity NFT; caller becomes owner.",
  });
}
