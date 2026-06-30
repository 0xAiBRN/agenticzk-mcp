// poker_recover_card — assemble plaintext from collected partial shares.
//
// On-chain DecryptSystem stores every published share d_i and fires
// RevealReady once threshold is met. To turn shares back into a card identity
// we need the BabyJub sum (which the contract deliberately keeps off-chain
// to save gas).
//
// Two modes:
//   - Community / flop / turn / river — every seated agent publishes; the
//     plaintext m = c2 - Σ d_i is fully reconstructable from chain state alone.
//   - Hole — only N-1 agents publish on-chain. The owner combines those N-1
//     shares with their own privately-computed d_owner = sk_owner · c1.
//     The owner's session seed is read from the PLAYER_SESSION_SEED server env
//     (audit K#1: never a tool argument) — the same seed publishSessionPk +
//     decrypt_share used — so this tool derives sk_owner locally without ever
//     transmitting it. Run on the OWNER'S machine only.
//
// Output: card identity 1..52 + decoded suit/rank label + raw plaintext point.
// Returns identity 0 (with a warning) when the recovered point doesn't match
// any canonical m_k = k·G — usually a sign of a wrong joint pk or missing /
// duplicated shares.

import { readContractWithRetry } from "../chains.js";
import { config } from "../config.js";
import { PokerDealAbi, PokerDecryptAbi, CardRole } from "../poker-abis.js";
import { okResult, errorResult, err } from "../errors.js";
import {
  cardIdentityFromPlaintext,
  decodeCardIdentity,
  deriveSessionKeypair,
  mulPointBabyJub,
  recoverPlaintext,
  type Point,
} from "../zk/shuffle-input.js";
import { loadSessionSeed } from "../wallet-env.js";

type RawArgs = {
  tableId: string;
  cardIdx: number;
  /** Test-only — accepted ONLY when POKER_ALLOW_TOOL_SEED=1 (smoke pattern).
   *  Production hole-recovery: per-agent multi-MCP child, env-seed. */
  ownerSeed?: string;
};

type RoleInfo = {
  role: number;
  threshold: number;
  owner: `0x${string}`;
};

type SessionEntry = { agent: `0x${string}`; pkX: bigint; pkY: bigint };
type SubmittedShare = { agent: `0x${string}`; share: Point };
type ToolErr = ReturnType<typeof errorResult>;

function isZero(p: Point): boolean {
  return p[0] === 0n && p[1] === 0n;
}

export async function pokerRecoverCardHandler(args: RawArgs) {
  const validated = _validateArgs(args);
  if ("error" in validated) return validated.error;
  const { tableId, cardIdx } = validated.valid;

  // 1. Determine threshold + role + (for hole) owner address.
  const roleRes = await _readRoleInfo(tableId, cardIdx);
  if ("error" in roleRes) return roleRes.error;
  const { role, threshold } = roleRes.info;

  // 2. Read ciphertext (need c2 for c2 - Σ d_i).
  const ctRes = await _readCiphertext(tableId, cardIdx);
  if ("error" in ctRes) return ctRes.error;
  const { c1, c2 } = ctRes;

  // 3. Pull the agent set (= session pk publishers) and their shares.
  const sharesRes = await _collectOnChainShares(tableId, cardIdx);
  if ("error" in sharesRes) return sharesRes.error;
  const submitted = sharesRes.submitted;

  // 4. For hole cards, supplement with owner's locally-computed share.
  const ownerRes = await _deriveOwnerShareIfHole(role, c1, args.ownerSeed);
  if ("error" in ownerRes) return ownerRes.error;
  const ownerShare = ownerRes.ownerShare;

  const totalShares = submitted.length + (ownerShare ? 1 : 0);
  if (totalShares < threshold + (role === CardRole.Hole ? 1 : 0)) {
    // Hole effective threshold for recovery = N (N-1 published + 1 owner).
    // Community effective threshold = N (= contract threshold).
    return errorResult(
      err(
        "E_NOT_ENOUGH_SHARES",
        `have ${totalShares} share(s), need ${role === CardRole.Hole ? threshold + 1 : threshold} for recovery`,
      ),
    );
  }

  // 5. Recover m = c2 - Σ shares; map to canonical card identity.
  return await _recoverAndDecode({ tableId, cardIdx, role, threshold, c2, submitted, ownerShare });
}

// ---------------------------------------------------------------------------
// Helpers (module-private).
// ---------------------------------------------------------------------------

function _validateArgs(
  args: RawArgs,
): { valid: { tableId: `0x${string}`; cardIdx: number } } | { error: ToolErr } {
  const tableId = args.tableId as `0x${string}`;
  if (!tableId || tableId.length !== 66 || !tableId.startsWith("0x")) {
    return { error: errorResult(err("E_INVALID_TABLE_ID", "tableId must be 32-byte hex")) };
  }
  if (args.cardIdx == null || args.cardIdx < 0 || args.cardIdx > 51) {
    return { error: errorResult(err("E_INVALID_CARD_IDX", "cardIdx must be in 0..51")) };
  }
  return { valid: { tableId, cardIdx: args.cardIdx } };
}

// audit 2026-05-22 MC-11 — readContractWithRetry explicit (RPC blip yutar);
// mevcut try/catch blocks korunur.
async function _readRoleInfo(
  tableId: `0x${string}`,
  cardIdx: number,
): Promise<{ info: RoleInfo } | { error: ToolErr }> {
  let role: number;
  let threshold: number;
  let owner: `0x${string}` = "0x0000000000000000000000000000000000000000";
  try {
    role = (await readContractWithRetry({
      address: config.pokerDecrypt as `0x${string}`,
      abi: PokerDecryptAbi,
      functionName: "cardRoleOf",
      args: [tableId, cardIdx],
    })) as number;
    threshold = (await readContractWithRetry({
      address: config.pokerDecrypt as `0x${string}`,
      abi: PokerDecryptAbi,
      functionName: "requiredSharesFor",
      args: [tableId, cardIdx],
    })) as number;
    if (role === CardRole.Hole) {
      owner = (await readContractWithRetry({
        address: config.pokerDecrypt as `0x${string}`,
        abi: PokerDecryptAbi,
        functionName: "holeOwnerOf",
        args: [tableId, cardIdx],
      })) as `0x${string}`;
    }
  } catch (e) {
    return {
      error: errorResult(err("E_DECRYPT_READ", `decrypt-system view failed: ${(e as Error).message}`)),
    };
  }
  if (role === CardRole.Burn || role === CardRole.Unused) {
    return {
      error: errorResult(
        err("E_NON_DECRYPTABLE", `cardIdx ${cardIdx} role=${role} (Burn/Unused) — no decryption defined`),
      ),
    };
  }
  return { info: { role, threshold, owner } };
}

async function _readCiphertext(
  tableId: `0x${string}`,
  cardIdx: number,
): Promise<{ c1: Point; c2: Point } | { error: ToolErr }> {
  try {
    const ct = (await readContractWithRetry({
      address: config.pokerDeal as `0x${string}`,
      abi: PokerDealAbi,
      functionName: "cardCiphertext",
      args: [tableId, cardIdx],
    })) as readonly [bigint, bigint, bigint, bigint];
    return { c1: [ct[0], ct[1]], c2: [ct[2], ct[3]] };
  } catch (e) {
    return { error: errorResult(err("E_DEAL_READ", `cardCiphertext read failed: ${(e as Error).message}`)) };
  }
}

async function _collectOnChainShares(
  tableId: `0x${string}`,
  cardIdx: number,
): Promise<{ submitted: SubmittedShare[] } | { error: ToolErr }> {
  let entries: readonly SessionEntry[];
  try {
    entries = (await readContractWithRetry({
      address: config.pokerDeal as `0x${string}`,
      abi: PokerDealAbi,
      functionName: "getSessionPks",
      args: [tableId],
    })) as readonly SessionEntry[];
  } catch (e) {
    return { error: errorResult(err("E_DEAL_READ", `getSessionPks failed: ${(e as Error).message}`)) };
  }
  if (entries.length === 0) {
    return { error: errorResult(err("E_NO_PKS", "no session pks published — joint pk not assembled")) };
  }

  const submitted: SubmittedShare[] = [];
  for (const e of entries) {
    let s: readonly [bigint, bigint];
    try {
      s = (await readContractWithRetry({
        address: config.pokerDecrypt as `0x${string}`,
        abi: PokerDecryptAbi,
        functionName: "getShare",
        args: [tableId, cardIdx, e.agent],
      })) as readonly [bigint, bigint];
    } catch {
      // Skip agents whose share read fails — treat as un-submitted.
      continue;
    }
    const pt: Point = [s[0], s[1]];
    if (!isZero(pt)) submitted.push({ agent: e.agent, share: pt });
  }
  return { submitted };
}

// audit 2026-05-22 K#1 — owner seed env-first; tool-arg fallback yalnızca
// POKER_ALLOW_TOOL_SEED=1 flag'i ile (smoke uyumluluğu).
async function _deriveOwnerShareIfHole(
  role: number,
  c1: Point,
  toolArgSeed?: string,
): Promise<{ ownerShare: Point | null } | { error: ToolErr }> {
  if (role !== CardRole.Hole) return { ownerShare: null };

  const seedResult = loadSessionSeed(toolArgSeed);
  if (typeof seedResult !== "bigint") {
    return { error: errorResult(err("E_NO_SESSION_SEED", seedResult.error)) };
  }
  try {
    const kp = await deriveSessionKeypair(seedResult);
    const ownerShare = await mulPointBabyJub(c1, kp.sk);
    return { ownerShare };
  } catch (e) {
    return {
      error: errorResult(err("E_OWNER_SHARE", `owner share derivation failed: ${(e as Error).message}`)),
    };
  }
}

async function _recoverAndDecode(input: {
  tableId: `0x${string}`;
  cardIdx: number;
  role: number;
  threshold: number;
  c2: Point;
  submitted: SubmittedShare[];
  ownerShare: Point | null;
}) {
  const allShares = input.submitted.map((s) => s.share);
  if (input.ownerShare) allShares.push(input.ownerShare);

  let m: Point;
  try {
    m = await recoverPlaintext(input.c2, allShares);
  } catch (e) {
    return errorResult(err("E_RECOVER_FAILED", `BabyJub recovery failed: ${(e as Error).message}`));
  }

  const identity = await cardIdentityFromPlaintext(m);
  const label = identity > 0 ? decodeCardIdentity(identity) : null;

  return okResult({
    tableId: input.tableId,
    cardIdx: input.cardIdx,
    role: input.role,
    threshold: input.threshold,
    sharesUsed: allShares.length,
    onChainSharesUsed: input.submitted.length,
    contributors: input.submitted.map((s) => s.agent),
    ownerCombined: input.ownerShare !== null,
    plaintext: { x: m[0].toString(), y: m[1].toString() },
    cardIdentity: identity,
    card: label,
    note:
      identity === 0
        ? "Recovered plaintext does not match any canonical m_k = k·G. Likely cause: missing/duplicate shares, wrong joint pk, or replay against stale ciphertext."
        : `Decoded card: ${label?.short ?? identity} (identity ${identity}/52).`,
  });
}
