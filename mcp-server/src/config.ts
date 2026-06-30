import "dotenv/config";
import * as path from "node:path";

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

// F-10 (Codex pre-mainnet readiness audit, 2026-05-20) — portable ZK artifact
// resolution. A public clone has no absolute machine-specific path. Each artifact
// is resolved as: explicit ZK_* env override → else relative to ZK_ARTIFACTS_DIR
// (the circuits build/ directory) → else a clear startup error. No
// machine-specific default is baked into the source.
const ZK_DIR = process.env.ZK_ARTIFACTS_DIR;
function zkArtifact(envKey: string, relPath: string): string {
  const explicit = process.env[envKey];
  if (explicit && explicit.length > 0) return explicit;
  if (ZK_DIR && ZK_DIR.length > 0) return path.join(ZK_DIR, relPath);
  throw new Error(
    `Missing ZK artifact config: set ${envKey} to the file path, or set ` +
      `ZK_ARTIFACTS_DIR to the circuits build/ directory.\n` +
      `A fresh clone has the manifest but NOT the ~712MB of zkey+wasm proving ` +
      `artifacts — fetch them (checksum-verified) with:\n` +
      `  pnpm --filter @agenticzk/agent-runner fetch:zk\n` +
      `then point ZK_ARTIFACTS_DIR at <agenticzk>/packages/circuits/build.`,
  );
}

// F-10 — prover backend resolved first so the rapidsnark binary is only
// required when that backend is actually selected.
const zkProverBackend = env("ZK_PROVER_BACKEND", "snarkjs");

export const config = {
  arcRpc: env("ARC_RPC", "https://rpc.testnet.arc.network"),
  // Codex 2026-05-13 B2 / Codex 2026-05-16 RPC burst rate root-cause handoff —
  // opsiyonel TX/READ split + multi-RPC fallback. Hiçbiri set değilse arcRpc
  // kullanılır (geriye dönük). agent-runner spawn anında bu env'leri geçiriyordu
  // (smoke-arc-8agent-usdc.ts L1126-1128); burada okumuyorduk → chains.ts
  // 17:19+17:47 koşumlarında dRPC direct endpoint'e burst atıp 429 yedi.
  // Şimdi chains.ts viem fallback transport'una besliyor.
  arcTxRpcUrl: process.env.ARC_TX_RPC_URL ?? null,
  arcReadRpcUrl: process.env.ARC_READ_RPC_URL ?? null,
  arcReadRpcUrls: (process.env.ARC_READ_RPC_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as string[],
  // F-10 — chain id is env-driven (defaults to Arc testnet 5042002; set
  // ARC_CHAIN_ID for any other Arc network, e.g. mainnet).
  arcChainId: Number(env("ARC_CHAIN_ID", "5042002")),

  // Stablecoins (6 decimals)
  usdc: env("USDC_ADDRESS", "0x3600000000000000000000000000000000000000") as `0x${string}`,
  eurc: env("EURC_ADDRESS", "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a") as `0x${string}`,

  // ERC-8183 Agentic Jobs
  erc8183: env("ERC8183_ADDRESS", "0x0747EEf0706327138c69792bF28Cd525089e4583") as `0x${string}`,

  // ERC-8004 Agent Identity — Arc-NATIVE registries (not part of AgenticZK's
  // deploy). Fallbacks are the canonical Arc testnet addresses; they are ALSO
  // emitted into latest.json.contracts → synced to .env.example/.mcp.json.example
  // (sync-examples), so a clone-user gets them from the same single source as the
  // poker contracts. agent_register/reputation/validate read these.
  identityRegistry: env("IDENTITY_REGISTRY", "0x8004A818BFB912233c491871b3d84c89A494BD9e") as `0x${string}`,
  reputationRegistry: env("REPUTATION_REGISTRY", "0x8004B663056A597Dffe9eCcC1965A193B7388713") as `0x${string}`,
  validationRegistry: env("VALIDATION_REGISTRY", "0x8004Cb1BF31DAf7788923b405b754f57acEB4272") as `0x${string}`,

  // CCTP v2 / StableFX / Swap config removed 2026-06-13 (money-tool teardown,
  // commit 9f8a64a) — the standalone Circle send/bridge/nano tools that used
  // these addresses no longer exist. EURC balance (read-only) is unaffected.

  // AgenticZK — env-required.
  //
  // 2026-05-11 — Codex public-readiness audit P0-2 fix. Eski hardcoded
  // default'lar her redeploy'da geride kaldığı için (M6.A 2026-04-26 →
  // 6+ redeploy turu) env zorunlu hale getirildi. Caller (agent-runner
  // start-all.sh veya kullanıcı `.mcp.json`'u) güncel adresleri sağlamalı.
  // En son redeploy adresleri: agenticzk/docs/DEPLOYMENT.md (2026-05-11
  // deep-audit refactor + USDC-only).
  //
  // POKER_RANDOMNESS_SYSTEM 2026-05-10 audit'inde legacy/'a taşındı
  // (Arc block.prevrandao = 0 → kullanılamaz, hiçbir sistem çağırmıyordu).
  pokerOrchestrator: env("POKER_ORCHESTRATOR") as `0x${string}`,
  // HC#11 ProtocolRegistry. Optional: when set, open-game discovery resolves the
  // canonical orchestrator from getActiveRelease() (drift-proof) instead of the
  // env address. When unset, discovery falls back to pokerOrchestrator + a warning.
  protocolRegistry: (process.env.POKER_PROTOCOL_REGISTRY ?? null) as `0x${string}` | null,
  // Optional: block the orchestrator was deployed at. When set, discovery scans
  // TournamentCreated logs from this block; otherwise it scans a recent window
  // (lookbackBlocks) and stamps the result as "recent window, not all-history".
  pokerOrchestratorDeployBlock: process.env.POKER_ORCHESTRATOR_DEPLOY_BLOCK
    ? BigInt(process.env.POKER_ORCHESTRATOR_DEPLOY_BLOCK)
    : null,
  pokerTable:        env("POKER_TABLE_SYSTEM") as `0x${string}`,
  pokerBet:          env("POKER_BET_SYSTEM")   as `0x${string}`,
  pokerShowdown:     env("POKER_SHOWDOWN_SYSTEM") as `0x${string}`,
  pokerDeal:         env("POKER_DEAL_SYSTEM")  as `0x${string}`,
  pokerDecrypt:      env("POKER_DECRYPT_SYSTEM") as `0x${string}`,
  pokerHandFlowRouter: process.env.POKER_HAND_FLOW_ROUTER as `0x${string}` | undefined,
  // 2026-05-24 — ShowdownInvoker. Üretim agent path'i (B-2 state-machine)
  // dealer-agent ile invokeShowdown çağırır. ShowdownInvoker.sol satır 87-89
  // "Anyone can call" → kontrat gating yok, env zorunlu sadece doğru adres için.
  pokerShowdownInvoker: env("POKER_SHOWDOWN_INVOKER") as `0x${string}`,

  // ZK shuffle artifacts — ZK Shuffle Gas milestone (2026-05-21). The legacy
  // single 418-public-signal `shuffle_encrypt_n52` circuit was split into three
  // commitment-public circuits selected by round index, plus a `deck_commit`
  // circuit for the DA-fault adjudication path:
  //   shuffle_first  round 0       deck_0 public,  output committed   (211 sig)
  //   shuffle_mid    rounds 1..N-2 both committed                     (4 sig)
  //   shuffle_last   round N-1     input committed, deck_N public     (211 sig)
  //   deck_commit    DA-fault      deck public, Poseidon commit out   (209 sig)
  // N=52 deck, snarkjs Groth16. Prover backend swappable: "snarkjs" (default,
  // JS, ~20 s/proof) or "rapidsnark" (C++ native, ~3-4 s/proof) — same zkey +
  // wasm for both. F-10 — paths resolved via zkArtifact (ZK_* override or
  // ZK_ARTIFACTS_DIR/<relPath>).
  zkShuffleFirstZkey: zkArtifact("ZK_SHUFFLE_FIRST_ZKEY", "shuffle_first_n52_final.zkey"),
  zkShuffleFirstWasm: zkArtifact(
    "ZK_SHUFFLE_FIRST_WASM",
    "shuffle_first_n52_js/shuffle_first_n52.wasm",
  ),
  zkShuffleMidZkey: zkArtifact("ZK_SHUFFLE_MID_ZKEY", "shuffle_mid_n52_final.zkey"),
  zkShuffleMidWasm: zkArtifact(
    "ZK_SHUFFLE_MID_WASM",
    "shuffle_mid_n52_js/shuffle_mid_n52.wasm",
  ),
  zkShuffleLastZkey: zkArtifact("ZK_SHUFFLE_LAST_ZKEY", "shuffle_last_n52_final.zkey"),
  zkShuffleLastWasm: zkArtifact(
    "ZK_SHUFFLE_LAST_WASM",
    "shuffle_last_n52_js/shuffle_last_n52.wasm",
  ),
  zkDeckCommitZkey: zkArtifact("ZK_DECK_COMMIT_ZKEY", "deck_commit_n52_final.zkey"),
  zkDeckCommitWasm: zkArtifact(
    "ZK_DECK_COMMIT_WASM",
    "deck_commit_n52_js/deck_commit_n52.wasm",
  ),
  zkProverBackend,
  // F-10 — the rapidsnark binary is required ONLY when that backend is
  // selected; with the snarkjs backend it stays optional (empty string).
  zkRapidsnarkBin:
    zkProverBackend === "rapidsnark"
      ? env("ZK_RAPIDSNARK_BIN")
      : (process.env.ZK_RAPIDSNARK_BIN ?? ""),

  // ZK decrypt artifacts (B3.7.C). elgamal_decrypt.circom — proves d = sk·c1
  // and pk = sk·G for a single share. Public signals (6): pk[2] + c1[2] + d[2].
  // Same prover backends work; circuit is small (~10K constraints).
  zkDecryptZkey: zkArtifact("ZK_DECRYPT_ZKEY", "elgamal_decrypt_final.zkey"),
  zkDecryptWasm: zkArtifact(
    "ZK_DECRYPT_WASM",
    "elgamal_decrypt_js/elgamal_decrypt.wasm",
  ),
} as const;
