import { config } from "../config.js";
import { ERC20Abi, readContractWithRetry } from "../chains.js";
import { okResult, errorResult, err } from "../errors.js";
import { formatUnits } from "viem";
import { validateAddress } from "../validate.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export async function balanceHandler(args: { address: string }) {
  // audit 2026-05-22 MC-09 — runtime adres doğrulama.
  const address = validateAddress(args.address);
  if (!address) {
    return errorResult(err("E_INVALID_ADDRESS", "address must be a valid 0x-prefixed 20-byte address"));
  }
  if (address === ZERO_ADDRESS) {
    return errorResult(err("E_INVALID_ADDRESS", "Address cannot be zero"));
  }

  // audit 2026-05-22 MC-11 — readContractWithRetry + üst-düzey try/catch
  // (RPC blip MCP crash'e dönüşmesin).
  let usdcBalance: bigint;
  let eurcBalance: bigint;
  try {
    [usdcBalance, eurcBalance] = await Promise.all([
      readContractWithRetry({
        address: config.usdc,
        abi: ERC20Abi,
        functionName: "balanceOf",
        args: [address],
      }) as Promise<bigint>,
      readContractWithRetry({
        address: config.eurc,
        abi: ERC20Abi,
        functionName: "balanceOf",
        args: [address],
      }) as Promise<bigint>,
    ]);
  } catch (e) {
    return errorResult(err("E_READ_FAILED", `balanceOf read failed: ${(e as Error).message}`));
  }

  return okResult({
    address,
    usdc: {
      raw: usdcBalance.toString(),
      formatted: formatUnits(usdcBalance, 6),
      symbol: "USDC",
    },
    eurc: {
      raw: eurcBalance.toString(),
      formatted: formatUnits(eurcBalance, 6),
      symbol: "EURC",
    },
    explorer: `https://testnet.arcscan.app/address/${address}`,
  });
}
