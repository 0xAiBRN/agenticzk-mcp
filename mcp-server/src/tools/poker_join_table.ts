import { encodeFunctionData, pad, toHex } from "viem";
import { config } from "../config.js";
import { PokerTableAbi } from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";
import { validateAddress } from "../validate.js";

export async function pokerJoinTableHandler(args: {
  player: string;
  tableId: string;
  seatIdx: number;
  agentId: string;
  buyInChips: string;
}) {
  // audit 2026-05-22 MC-09 — runtime adres doğrulama.
  const player = validateAddress(args.player);
  if (!player) {
    return errorResult(err("E_INVALID_ADDRESS", "player must be a valid 0x-prefixed 20-byte address"));
  }
  const tableId = args.tableId as `0x${string}`;

  if (player === "0x0000000000000000000000000000000000000000") {
    return errorResult(err("E_INVALID_PLAYER", "player address cannot be zero"));
  }
  if (!tableId || tableId.length !== 66) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex"));
  }
  if (args.seatIdx < 0 || args.seatIdx > 8) {
    return errorResult(err("E_INVALID_SEAT", "seatIdx must be 0..8"));
  }

  let agentBig: bigint;
  let buyIn: bigint;
  try {
    agentBig = BigInt(args.agentId);
    buyIn = BigInt(args.buyInChips);
  } catch {
    return errorResult(err("E_INVALID_NUMBER", "agentId and buyInChips must be numeric strings"));
  }
  if (agentBig <= 0n) return errorResult(err("E_INVALID_AGENT_ID", "agentId must be positive"));
  if (buyIn <= 0n)    return errorResult(err("E_INVALID_BUYIN",   "buyInChips must be positive"));

  // Encode agentId (uint256) into bytes32 (TableSystem stores agentId as bytes32).
  const agentBytes32 = pad(toHex(agentBig), { size: 32 });

  const data = encodeFunctionData({
    abi: PokerTableAbi,
    functionName: "joinTable",
    args: [tableId, args.seatIdx, agentBytes32, buyIn],
  });

  return okResult({
    unsignedTx: {
      to: config.pokerTable,
      data,
      value: "0",
      chainId: config.arcChainId,
    },
    player,
    tableId,
    seatIdx: args.seatIdx,
    agentId: agentBig.toString(),
    buyInChips: buyIn.toString(),
    note: "Player signs. Seat is reserved with provided chips stack.",
  });
}
