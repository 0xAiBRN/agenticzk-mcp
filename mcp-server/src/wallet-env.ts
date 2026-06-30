// audit 2026-05-22 K#1 — the ONLY secret an MCP tool reads is the ZK mental-poker
// session SEED, taken from the server's process env (NOT from a tool argument).
//
// Problem: if a tool schema accepted a secret as a parameter, every call would
// serialize it into the LLM tool-call JSON → it lands in OpenRouter / Anthropic
// request bodies, conversation history and artifact files, where anyone with
// provider-log access could read it. So the secret is read from the server env
// (the user sets it in `.mcp.json` env or `.env`); the LLM never sees it.
//
// 2026-06-13 (mission-scope teardown, Sahip-approved) — the wallet-PK loader
// (loadPlayerPk) was REMOVED along with the standalone Circle money tools
// (send_token / bridge_send / nano_*). The MCP no longer reads a wallet private
// key AT ALL: every poker tool returns an UNSIGNED tx the harness signs. The
// session SEED below is now the sole secret, used only for off-chain BabyJubJub
// decrypt math — never to sign a transaction.

/**
 * audit 2026-05-22 K#1 — ZK mental-poker session seed'i server env'inden oku.
 *
 * `poker_publish_session_pk` bu seed'den `sk_i`/`pk_i` türetir; `poker_decrypt_share`,
 * `poker_decrypt_batch` ve `poker_recover_card` AYNI seed'den `sk_i`'yi yeniden
 * türetir (decrypt payını / hole-kart kurtarmayı yapmak için). Seed tool argümanı
 * olduğunda her çağrı onu LLM tool-call JSON'una serialize eder → provider loguna
 * sızar; rakip kurbanın hole kartlarını açabilir. Seed masa ömrü boyunca STABİL
 * olmalı (CSPRNG değil — publish'teki pk ile decrypt'teki sk eşleşmeli), dolayısıyla
 * server env'i (`PLAYER_SESSION_SEED`) doğru yer.
 *
 * Başarılıysa pozitif `bigint` döndürür; aksi halde `{ error }`.
 */
export function loadSessionSeed(
  toolArgSeed?: string,
): bigint | { error: string } {
  // audit 2026-05-22 K#1 — Production: seed env'den, LLM görmez.
  //
  // 2026-05-23 smoke uyumluluğu: Multi-agent smoke tek MCP child kullanıyor
  // ama her agent kendi seed'i ile çalışmalı (joint pk = Σ pk_i; iki agent
  // aynı seed = aynı pk_i kriptografik olarak yanlış). Smoke için per-call
  // seed kabul izni `POKER_ALLOW_TOOL_SEED=1` env-flag arkasında — production
  // .env'de set EDİLMEZ, MC-01 fix aktif kalır. `POKER_ALLOW_SEED` (shuffle
  // RNG seed bypass) ile aynı pattern. Multi-MCP child mainnet pattern'ı —
  // her agent kendi process'i kendi env'i — V2 smoke milestone'ı.
  if (toolArgSeed !== undefined && process.env.POKER_ALLOW_TOOL_SEED === "1") {
    let seed: bigint;
    try {
      seed = BigInt(toolArgSeed.startsWith("0x") ? toolArgSeed : `0x${toolArgSeed}`);
    } catch {
      return { error: "tool-supplied seed must be a hex-encoded 256-bit number" };
    }
    if (seed <= 0n) {
      return { error: "tool-supplied seed must be a positive (non-zero) value" };
    }
    return seed;
  }
  const raw = process.env.PLAYER_SESSION_SEED;
  if (!raw) {
    return {
      error:
        "PLAYER_SESSION_SEED env not set on the MCP server (required for ZK " +
        "session-key tools — set it in .mcp.json env or the server .env, never " +
        "pass a seed in a tool call). Test-only: POKER_ALLOW_TOOL_SEED=1 to " +
        "re-enable seed tool-arg pattern.",
    };
  }
  let seed: bigint;
  try {
    seed = BigInt(raw.startsWith("0x") ? raw : `0x${raw}`);
  } catch {
    return { error: "PLAYER_SESSION_SEED env must be a hex-encoded 256-bit number" };
  }
  if (seed <= 0n) {
    return { error: "PLAYER_SESSION_SEED env must be a positive (non-zero) value" };
  }
  return seed;
}
