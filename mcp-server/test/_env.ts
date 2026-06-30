// F-12 — test-only env shim. config.ts reads required env vars (poker contract
// addresses, ZK artifact dir) at import time and throws if they are missing.
// A unit test that imports a tool (which imports config.ts) must set these
// FIRST. Import this module before any tool import. `??=` keeps real values
// from a developer's .env intact and only fills gaps for CI / fresh checkouts.
process.env.POKER_ORCHESTRATOR ??= "0x0000000000000000000000000000000000000a01";
process.env.POKER_TABLE_SYSTEM ??= "0x0000000000000000000000000000000000000a02";
process.env.POKER_BET_SYSTEM ??= "0x0000000000000000000000000000000000000a03";
process.env.POKER_SHOWDOWN_SYSTEM ??= "0x0000000000000000000000000000000000000a04";
process.env.POKER_DEAL_SYSTEM ??= "0x0000000000000000000000000000000000000a05";
process.env.POKER_DECRYPT_SYSTEM ??= "0x0000000000000000000000000000000000000a06";
process.env.POKER_SHOWDOWN_INVOKER ??= "0x0000000000000000000000000000000000000a07";
process.env.ZK_ARTIFACTS_DIR ??= "/tmp/arcent-zk-test-artifacts";
