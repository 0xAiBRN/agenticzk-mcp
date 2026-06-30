// poker_decrypt_batch — one agent submits shares for several cards in one tx.
//
// This keeps the mental-poker trust model intact: every card still has its own
// DLEQ proof and DecryptSystem verifies each proof on chain. The saving is only
// transaction overhead, mainly for the flop's three community cards.

import { encodeFunctionData } from "viem";
import { readContractWithRetry } from "../chains.js";
import { config } from "../config.js";
import { PokerDealAbi, PokerDecryptAbi, CardRole } from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";
import { validateAddress } from "../validate.js";
import {
  deriveSessionKeypair,
  mulPointBabyJub,
  type Point,
} from "../zk/shuffle-input.js";
import { makeDecryptProver, proofToSolidityCalldata } from "../zk/prover.js";
import { loadSessionSeed } from "../wallet-env.js";

type ShareMaterial = {
  cardIdx: number;
  role: number;
  d: Point;
  pA: readonly [bigint, bigint];
  pB: readonly [readonly [bigint, bigint], readonly [bigint, bigint]];
  pC: readonly [bigint, bigint];
  proveMs: number;
  totalMs: number;
};

// audit 2026-05-22 MC-11 — buildShareMaterial readContractWithRetry kullanır;
// caller (handler aşağıda) E_BATCH_PROVE_FAILED try/catch'i ile sarıyor.
async function buildShareMaterial(
  tableId: `0x${string}`,
  cardIdx: number,
  pk: Point,
  sk: bigint,
  agentAddress?: string,
): Promise<ShareMaterial> {
  const role = (await readContractWithRetry({
    address: config.pokerDecrypt as `0x${string}`,
    abi: PokerDecryptAbi,
    functionName: "cardRoleOf",
    args: [tableId, cardIdx],
  })) as number;

  if (role === CardRole.Burn || role === CardRole.Unused) {
    throw new Error(`cardIdx ${cardIdx} role=${role} (Burn/Unused) is not decryptable`);
  }

  if (agentAddress && role === CardRole.Hole) {
    const owner = (await readContractWithRetry({
      address: config.pokerDecrypt as `0x${string}`,
      abi: PokerDecryptAbi,
      functionName: "holeOwnerOf",
      args: [tableId, cardIdx],
    })) as `0x${string}`;
    if (owner.toLowerCase() === agentAddress.toLowerCase()) {
      throw new Error(`agent ${agentAddress} owns hole card ${cardIdx}; owner shares use showdown mode`);
    }
  }

  const ct = (await readContractWithRetry({
    address: config.pokerDeal as `0x${string}`,
    abi: PokerDealAbi,
    functionName: "cardCiphertext",
    args: [tableId, cardIdx],
  })) as readonly [bigint, bigint, bigint, bigint];
  const c1: Point = [ct[0], ct[1]];
  if (c1[0] === 0n && c1[1] === 0n) {
    throw new Error(`cardCiphertext for cardIdx ${cardIdx} is zero`);
  }

  const d = await mulPointBabyJub(c1, sk);
  const witness = {
    pk: [pk[0].toString(), pk[1].toString()],
    c1: [c1[0].toString(), c1[1].toString()],
    d:  [d[0].toString(),  d[1].toString()],
    sk: sk.toString(),
  };
  const proof = await makeDecryptProver().prove(witness);
  const calldata = proofToSolidityCalldata(proof.proof);
  return {
    cardIdx,
    role,
    d,
    pA: calldata.pA,
    pB: calldata.pB,
    pC: calldata.pC,
    proveMs: Math.round(proof.timings.proveMs),
    totalMs: Math.round(proof.timings.totalMs),
  };
}

export async function pokerDecryptBatchHandler(args: {
  tableId: string;
  cardIdxs: number[];
  /** Optional agent wallet address for early local hole-owner checks. */
  agentAddress?: string;
}) {
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66 || !tableId.startsWith("0x")) {
    return errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex"));
  }
  if (!Array.isArray(args.cardIdxs) || args.cardIdxs.length === 0 || args.cardIdxs.length > 5) {
    return errorResult(err("E_INVALID_CARD_IDXS", "cardIdxs must contain 1..5 deck slots"));
  }
  // audit 2026-05-22 MC-09 — opsiyonel agentAddress runtime adres doğrulaması;
  // verilmişse geçerli olmalı (hole-owner short-circuit toLowerCase ile yapılıyor,
  // geçersiz string sessizce eşleşmez ama defansif olarak hatayı net döndür).
  if (args.agentAddress !== undefined && validateAddress(args.agentAddress) === null) {
    return errorResult(err("E_INVALID_ADDRESS", "agentAddress must be a valid 0x-prefixed 20-byte address"));
  }
  const cardIdxs = args.cardIdxs.map((v) => Number(v));
  if (cardIdxs.some((v) => !Number.isInteger(v) || v < 0 || v > 51)) {
    return errorResult(err("E_INVALID_CARD_IDXS", "all cardIdxs must be integers in 0..51"));
  }
  if (new Set(cardIdxs).size !== cardIdxs.length) {
    return errorResult(err("E_DUPLICATE_CARD_IDX", "cardIdxs must be unique"));
  }

  // audit 2026-05-22 K#1 — session seed env-first; tool-arg fallback gated by
  // POKER_ALLOW_TOOL_SEED=1 env-flag (smoke uyumluluğu).
  const seedResult = loadSessionSeed((args as { seed?: string }).seed);
  if (typeof seedResult !== "bigint") {
    return errorResult(err("E_NO_SESSION_SEED", seedResult.error));
  }
  const seedBig = seedResult;

  let sk: bigint;
  let pk: Point;
  try {
    const kp = await deriveSessionKeypair(seedBig);
    sk = kp.sk;
    pk = kp.pk;
  } catch (e) {
    return errorResult(err("E_DERIVE_FAILED", `keypair derivation failed: ${(e as Error).message}`));
  }

  let shares: ShareMaterial[];
  try {
    shares = [];
    for (const cardIdx of cardIdxs) {
      shares.push(await buildShareMaterial(tableId, cardIdx, pk, sk, args.agentAddress));
    }
  } catch (e) {
    return errorResult(err("E_BATCH_PROVE_FAILED", (e as Error).message));
  }

  const data = encodeFunctionData({
    abi: PokerDecryptAbi,
    functionName: "submitPartialDecryptShares",
    args: [
      tableId,
      cardIdxs,
      [pk[0], pk[1]],
      shares.map((s) => [s.d[0], s.d[1]] as readonly [bigint, bigint]),
      shares.map((s) => s.pA),
      shares.map((s) => s.pB),
      shares.map((s) => s.pC),
    ],
  });

  return okResult({
    unsignedTx: {
      to: config.pokerDecrypt,
      data,
      value: "0",
      chainId: config.arcChainId,
    },
    tableId,
    cardIdxs,
    roles: shares.map((s) => s.role),
    pkX: pk[0].toString(),
    pkY: pk[1].toString(),
    shares: shares.map((s) => ({
      cardIdx: s.cardIdx,
      dX: s.d[0].toString(),
      dY: s.d[1].toString(),
      proveMs: s.proveMs,
      totalMs: s.totalMs,
    })),
    backend: config.zkProverBackend,
    proveMs: shares.reduce((acc, s) => acc + s.proveMs, 0),
    totalMs: shares.reduce((acc, s) => acc + s.totalMs, 0),
    note:
      "Batch partial decrypt shares ready. Broadcast one tx; DecryptSystem " +
      "verifies every card proof on-chain and emits RevealReady per card when " +
      "the threshold is reached.",
  });
}
