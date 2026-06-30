// Build a snarkjs witness input for the N=52 shuffle_encrypt circuit.
//
// The circuit proves: outputC1[i] = inputC1[positions[i]] + r[i]·G,
//                     outputC2[i] = inputC2[positions[i]] + r[i]·pk,
// where positions is a permutation (and invPositions its inverse).
//
// Given (pk, inputC1[52], inputC2[52]) the prover picks fresh randomness
// (positions, r[]) and computes (outputC1, outputC2) on the BabyJubJub curve,
// then writes everything as decimal-string-encoded points for snarkjs.
//
// Determinism: the caller passes the seeded RNG so smoke tests can reproduce
// proofs. Production wallets get a CSPRNG (`crypto.randomBytes`).

import { buildBabyjub } from "circomlibjs";
import { randomBytes as nodeCryptoRandomBytes } from "node:crypto";
import { keccak256, encodeAbiParameters, stringToBytes, bytesToBigInt } from "viem";

const DECK_SIZE = 52;
const SUB_ORDER =
  2736030358979909402780800718157159386076813972158567259200215660948447373041n;

export type Point = [bigint, bigint];
export type RNG = () => bigint;

export type ShuffleProveInput = {
  pk: Point;
  inputC1: Point[];
  inputC2: Point[];
};

export type ShuffleProveOutput = {
  /** snarkjs-shaped witness input (decimal-string fields). */
  witness: {
    pk: [string, string];
    inputC1: [string, string][];
    inputC2: [string, string][];
    outputC1: [string, string][];
    outputC2: [string, string][];
    positions: string[];
    invPositions: string[];
    r: string[];
  };
  /** Output ciphertexts as bigint pairs (for tx encoding). */
  outputC1: Point[];
  outputC2: Point[];
  /** Permutation + per-card randomness chosen by this agent. Kept for audit/debug. */
  positions: number[];
  r: bigint[];
};

/** Fisher-Yates shuffle over [0..N-1] using the supplied RNG (modular). */
function fisherYates(n: number, rng: RNG): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    // Bias is negligible for n=52 << 2^256, so straight modulo is fine.
    const j = Number(rng() % BigInt(i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Build a witness for one agent's shuffle round.
 * @param input pk + current deck ciphertexts (read from DealSystem on-chain).
 * @param rng   bigint generator (≥ 256 bits each call). Reduced mod subOrder.
 */
export async function buildShuffleWitness(
  input: ShuffleProveInput,
  rng: RNG,
): Promise<ShuffleProveOutput> {
  if (input.inputC1.length !== DECK_SIZE || input.inputC2.length !== DECK_SIZE) {
    throw new Error(
      `expected ${DECK_SIZE} input ciphertexts, got C1=${input.inputC1.length}, C2=${input.inputC2.length}`,
    );
  }

  const bj = await buildBabyjub();
  const G = bj.Base8;

  // Drive permutation and randomness from the same RNG so callers control
  // determinism vs CSPRNG with one knob.
  const positions = fisherYates(DECK_SIZE, rng);
  const invPositions = new Array<number>(DECK_SIZE);
  for (let i = 0; i < DECK_SIZE; i++) invPositions[positions[i]] = i;

  // audit 2026-05-22 K#2 — her kart için SIFIR OLMAYAN ElGamal blinding zorunlu.
  // r[i]=0 ise mulPointEscalar(G,0)=mulPointEscalar(pk,0)=identity döner ve kart
  // YENİDEN ŞİFRELENMEZ (outC1==inC1, outC2==inC2). Rakip, bir önceki round'un
  // ciphertext'iyle birebir eşleşmeden kartın permütasyondaki gerçek konumunu
  // çıkarır → kart-başına shuffle gizliliği kırılır. rng()%SUB_ORDER 0 verirse
  // reddet ve yeniden çek.
  const r: bigint[] = [];
  for (let i = 0; i < DECK_SIZE; i++) {
    let ri = rng() % SUB_ORDER;
    while (ri === 0n) ri = rng() % SUB_ORDER;
    r.push(ri);
  }

  // pk as a curve point (the circuit re-encrypts under it).
  const pkPoint: [Uint8Array, Uint8Array] = [
    bj.F.e(input.pk[0]),
    bj.F.e(input.pk[1]),
  ];

  const inC1: [Uint8Array, Uint8Array][] = input.inputC1.map((p) => [
    bj.F.e(p[0]),
    bj.F.e(p[1]),
  ]);
  const inC2: [Uint8Array, Uint8Array][] = input.inputC2.map((p) => [
    bj.F.e(p[0]),
    bj.F.e(p[1]),
  ]);

  const outC1F: [Uint8Array, Uint8Array][] = [];
  const outC2F: [Uint8Array, Uint8Array][] = [];
  for (let i = 0; i < DECK_SIZE; i++) {
    const src = positions[i];
    const rG = bj.mulPointEscalar(G, r[i]);
    const rPk = bj.mulPointEscalar(pkPoint, r[i]);
    outC1F.push(bj.addPoint(inC1[src], rG) as [Uint8Array, Uint8Array]);
    outC2F.push(bj.addPoint(inC2[src], rPk) as [Uint8Array, Uint8Array]);
  }

  const fmt = (p: [Uint8Array, Uint8Array]): [string, string] => [
    bj.F.toString(p[0]),
    bj.F.toString(p[1]),
  ];

  const witness = {
    pk: fmt(pkPoint),
    inputC1: inC1.map(fmt),
    inputC2: inC2.map(fmt),
    outputC1: outC1F.map(fmt),
    outputC2: outC2F.map(fmt),
    positions: positions.map((n) => n.toString()),
    invPositions: invPositions.map((n) => n.toString()),
    r: r.map((b) => b.toString()),
  };

  // Convert outputs back to bigint pairs for tx encoding.
  const toBig = (p: [Uint8Array, Uint8Array]): Point => [
    BigInt(bj.F.toString(p[0])),
    BigInt(bj.F.toString(p[1])),
  ];

  return {
    witness,
    outputC1: outC1F.map(toBig),
    outputC2: outC2F.map(toBig),
    positions,
    r,
  };
}

/** CSPRNG-backed RNG for production. Returns a 256-bit bigint per call. */
export function csprngRng(): RNG {
  // crypto.randomBytes is sync and uses OpenSSL CSPRNG — fine for a few dozen calls per hand.
  return () => {
    const buf = nodeCryptoRandomBytes(32);
    return BigInt("0x" + buf.toString("hex"));
  };
}

/**
 * Deterministic seeded RNG (xorshift-like over bigint). For smoke tests / debug.
 * Two callers passing the same seed get the same permutation + r[].
 */
export function seededRng(seed: bigint): RNG {
  let state = seed === 0n ? 1n : seed;
  return () => {
    state ^= state << 13n;
    state ^= state >> 7n;
    state ^= state << 17n;
    state &= (1n << 256n) - 1n;
    return state;
  };
}

/**
 * Derive a BabyJubJub session keypair from a 256-bit seed.
 * `sk = seed mod subOrder`, `pk = sk · Base8`.
 *
 * Used by poker_publish_session_pk + poker_decrypt_share to:
 *  - publish pk_i on-chain at hand start (agent self-attestation)
 *  - compute the agent's per-hand decrypt share d_i = sk_i · c1
 *
 * The seed is the *agent's secret*: never sent over the wire, never stored
 * server-side. Production wallets should derive it via HKDF(walletSk,
 * tableId || handNumber) so it's reconstructible across MCP restarts but
 * still indistinguishable from random to anyone without walletSk.
 */
export async function deriveSessionKeypair(seed: bigint): Promise<{
  sk: bigint;
  pk: Point;
}> {
  const bj = await buildBabyjub();
  const sk = ((seed % SUB_ORDER) + SUB_ORDER) % SUB_ORDER;
  if (sk === 0n) {
    // pk = 0·G = identity, useless as a session pk. Reject so the agent picks
    // a non-trivial seed (vanishingly rare with a CSPRNG).
    throw new Error("session sk reduces to 0 — pick a different seed");
  }
  const pkPoint = bj.mulPointEscalar(bj.Base8, sk) as [Uint8Array, Uint8Array];
  return {
    sk,
    pk: [BigInt(bj.F.toString(pkPoint[0])), BigInt(bj.F.toString(pkPoint[1]))],
  };
}

/**
 * C-1 (deep audit 2026-06-29) — build a Schnorr proof-of-possession for a
 * session pk, proving knowledge of sk = dlog(pk) w.r.t. Base8. The Fiat-Shamir
 * challenge is byte-identical to DealSystem.publishSessionPk's on-chain
 * keccak256(abi.encode(...)), so the on-chain verify `s·Base8 == R + e·pk`
 * accepts. Closes the rogue-key / forged-pk attack (a forged pk has no valid
 * proof) without any circuit/ceremony change.
 *
 * SECURITY (R1 — load-bearing): the nonce `r` MUST come from a CSPRNG and MUST
 * be fresh per call. Reusing `r` across two publishes (same wallet, two tables)
 * leaks `sk = (s1−s2)·(e1−e2)⁻¹`. We use node:crypto `randomBytes` and NEVER a
 * seed-derived / deterministic nonce. `r` is NEVER returned (returning it with
 * the public `s` would reveal `sk`).
 */
export async function buildSessionPkPoP(params: {
  sk: bigint;
  pk: Point;
  tableId: `0x${string}`;
  agentAddress: `0x${string}`;
  dealAddress: `0x${string}`;
  chainId: number;
}): Promise<{ Rx: bigint; Ry: bigint; s: bigint }> {
  const { sk, pk, tableId, agentAddress, dealAddress, chainId } = params;
  const bj = await buildBabyjub();
  const L = SUB_ORDER;
  const POP_DOMAIN = keccak256(stringToBytes("AgenticZK.DealSystem.SessionPkPoP.v1"));
  const pkPoint = [bj.F.e(pk[0]), bj.F.e(pk[1])] as [Uint8Array, Uint8Array];

  for (let attempt = 0; attempt < 16; attempt++) {
    // CSPRNG nonce r ∈ [1, L). NEVER seed-derived (R1).
    const r = bytesToBigInt(nodeCryptoRandomBytes(32)) % L;
    if (r === 0n) continue;
    const Rpt = bj.mulPointEscalar(bj.Base8, r) as [Uint8Array, Uint8Array];
    const Rx = BigInt(bj.F.toString(Rpt[0]));
    const Ry = BigInt(bj.F.toString(Rpt[1]));
    const e = BigInt(keccak256(encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "uint256" }, { type: "address" },
        { type: "bytes32" }, { type: "address" }, { type: "uint256" },
        { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
      ],
      [POP_DOMAIN, BigInt(chainId), dealAddress, tableId, agentAddress, pk[0], pk[1], Rx, Ry],
    ))) % L;
    if (e === 0n) continue;
    const s = (r + e * sk) % L;
    if (s === 0n) continue;
    // self-verify: s·Base8 == R + e·pk, using THIS function's own `e`.
    // HONEST SCOPE (hard audit 2026-06-30, C1-INFO-1): because s=(r+e·sk)%L,
    // R=r·Base8 and pk=sk·Base8 all derive from the same keypair, this equation
    // is an algebraic identity that holds for ANY `e`. It therefore only catches
    // an INTERNAL keypair inconsistency (pk ≠ sk·Base8 — a circomlib/field bug).
    // It does NOT and CANNOT detect a wrong chainId / DealSystem address /
    // agentAddress: those only change `e`, and the identity holds regardless.
    // The ACTUAL guard against challenge-input drift is the on-chain verify
    // (DealSystem.publishSessionPk recomputes `e` from the real block.chainid /
    // address(this) / msg.sender and reverts SessionPkProofInvalid on mismatch).
    // The release-hashes/encoding cross-check test locks our abi.encode layout
    // to the contract's keccak so a future refactor cannot silently desync it.
    const lhs = bj.mulPointEscalar(bj.Base8, s) as [Uint8Array, Uint8Array];
    const rhs = bj.addPoint(Rpt, bj.mulPointEscalar(pkPoint, e)) as [Uint8Array, Uint8Array];
    if (
      bj.F.toString(lhs[0]) === bj.F.toString(rhs[0]) &&
      bj.F.toString(lhs[1]) === bj.F.toString(rhs[1])
    ) {
      return { Rx, Ry, s };
    }
    // Reaching here means pk ≠ sk·Base8 (internal keypair inconsistency), NOT a
    // config drift — fail loud rather than emit a structurally-broken proof.
    throw new Error(
      "PoP self-verify failed — internal keypair inconsistency (pk ≠ sk·Base8). " +
        "This is a BabyJub/field-arithmetic bug, not an env mismatch.",
    );
  }
  throw new Error("PoP nonce generation exhausted retries (CSPRNG degenerate)");
}

/**
 * Sum a list of BabyJubJub points (off-chain joint pk aggregation).
 * Returns the identity (0, 1) for an empty list — agents should treat this as
 * "no published pks yet" and refuse to trust the deck.
 */
export async function sumBabyJubPoints(points: Point[]): Promise<Point> {
  const bj = await buildBabyjub();
  // BabyJub identity in Edwards form is (0, 1).
  let acc: [Uint8Array, Uint8Array] = [bj.F.e(0n), bj.F.e(1n)];
  for (const p of points) {
    const pf: [Uint8Array, Uint8Array] = [bj.F.e(p[0]), bj.F.e(p[1])];
    acc = bj.addPoint(acc, pf) as [Uint8Array, Uint8Array];
  }
  return [BigInt(bj.F.toString(acc[0])), BigInt(bj.F.toString(acc[1]))];
}

// ─────────────────────────────────────────────────────────────────────────
// B3.7.C — partial-decrypt + plaintext recovery on BabyJubJub.
// Mirrors the elgamal_decrypt circuit's math so off-chain agents can compute
// d_i = sk_i · c1 themselves (and verify reveal m = c2 - Σ d_i).
// ─────────────────────────────────────────────────────────────────────────

/** Variable-base scalar mul on BabyJub: returns scalar · point. */
export async function mulPointBabyJub(point: Point, scalar: bigint): Promise<Point> {
  const bj = await buildBabyjub();
  const k = ((scalar % SUB_ORDER) + SUB_ORDER) % SUB_ORDER;
  const pf: [Uint8Array, Uint8Array] = [bj.F.e(point[0]), bj.F.e(point[1])];
  const out = bj.mulPointEscalar(pf, k) as [Uint8Array, Uint8Array];
  return [BigInt(bj.F.toString(out[0])), BigInt(bj.F.toString(out[1]))];
}

/**
 * BabyJub Edwards-curve negation: −(x, y) = (−x mod p, y).
 * Field p is the BN254 scalar field — bj.F.neg handles the modular reduction.
 */
export async function negPoint(p: Point): Promise<Point> {
  const bj = await buildBabyjub();
  const xF = bj.F.e(p[0]);
  const yF = bj.F.e(p[1]);
  const negX = bj.F.neg(xF);
  return [BigInt(bj.F.toString(negX)), BigInt(bj.F.toString(yF))];
}

/** a − b on BabyJub. */
export async function subBabyJubPoints(a: Point, b: Point): Promise<Point> {
  const nb = await negPoint(b);
  return sumBabyJubPoints([a, nb]);
}

/**
 * Recover plaintext point m = c2 − Σ shares.
 * Caller passes every d_i for the card (including the hole-owner's
 * privately-computed share when applicable). DecryptSystem stores 0-points
 * for un-submitted slots — drop those before calling.
 */
export async function recoverPlaintext(c2: Point, shares: Point[]): Promise<Point> {
  const sumShares = await sumBabyJubPoints(shares);
  return subBabyJubPoints(c2, sumShares);
}

/**
 * Build the canonical plaintext lookup table m_k = k · G for k = 1..52.
 * Cached after first call (52 fixed points, deterministic, ~10 ms cold).
 *
 * The initial deck (poker_hand_start.buildInitialDeck) encodes card identity
 * k ∈ {1..52} as plaintext m_k = k · G. After arbitrary shuffles + re-encrypts,
 * a slot's recovered plaintext is still some m_k — we just don't know which k
 * without this table.
 */
// audit 2026-05-22 MC-21 / Tema 9 — promise-singleton race fix
// (cachedPoseidon ile aynı pattern; detay deck-commit.ts).
let cachedDeckTable: Promise<ReadonlyArray<Point>> | null = null;
export function deckPlaintextTable(): Promise<ReadonlyArray<Point>> {
  cachedDeckTable ??= (async () => {
    const bj = await buildBabyjub();
    const G = bj.Base8;
    const tbl: Point[] = [];
    for (let k = 1; k <= 52; k++) {
      const pf = bj.mulPointEscalar(G, BigInt(k)) as [Uint8Array, Uint8Array];
      tbl.push([BigInt(bj.F.toString(pf[0])), BigInt(bj.F.toString(pf[1]))]);
    }
    return tbl;
  })();
  return cachedDeckTable;
}

/**
 * Card identity (1..52) for a recovered plaintext point. Returns 0 if the
 * point doesn't match any canonical m_k (corruption / wrong joint pk).
 */
export async function cardIdentityFromPlaintext(m: Point): Promise<number> {
  const tbl = await deckPlaintextTable();
  for (let i = 0; i < tbl.length; i++) {
    if (tbl[i][0] === m[0] && tbl[i][1] === m[1]) return i + 1;
  }
  return 0;
}

/**
 * Decode a 1..52 card identity into (suit, rank). Convention is the same one
 * DealSystem documents:
 *   identity-1 (0..51) → suit = floor(idx/13)  (0..3)
 *                       rank = idx % 13 + 2   (2..14, 14 = Ace)
 *
 * Suit names are advisory — HandEval doesn't care about labels, only ordering.
 */
export type CardLabel = {
  identity: number;        // 1..52
  suit: 0 | 1 | 2 | 3;
  suitName: "clubs" | "diamonds" | "hearts" | "spades";
  rank: number;            // 2..14
  rankName: string;        // "2".."10","J","Q","K","A"
  short: string;           // e.g. "Ah", "Td"
};

const SUIT_NAMES = ["clubs", "diamonds", "hearts", "spades"] as const;
const SUIT_SHORT = ["c", "d", "h", "s"] as const;
const RANK_NAMES = [
  "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A",
] as const;

export function decodeCardIdentity(identity: number): CardLabel | null {
  if (identity < 1 || identity > 52) return null;
  const idx = identity - 1;
  const suit = Math.floor(idx / 13) as 0 | 1 | 2 | 3;
  const rank = (idx % 13) + 2;
  return {
    identity,
    suit,
    suitName: SUIT_NAMES[suit],
    rank,
    rankName: RANK_NAMES[rank - 2],
    short: `${RANK_NAMES[rank - 2]}${SUIT_SHORT[suit]}`,
  };
}
