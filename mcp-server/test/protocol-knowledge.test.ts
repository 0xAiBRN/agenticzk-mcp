// protocol-knowledge.test.ts — FIX-3 (Path B build, 2026-06-22) drift guard.
//
// The three Path-B orchestration surfaces (SERVER_INSTRUCTIONS,
// PROTOCOL_SPEC_RESOURCE, buildPlayFullHandPrompt) MUST reference every protocol
// step in the production full-hand loop and MUST NOT reference deleted/false
// surfaces. A wrong order bricks a live hand — this is the cheap regression that
// catches a step being dropped or a stale claim creeping back in.

import "./_env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SERVER_INSTRUCTIONS,
  PROTOCOL_SPEC_RESOURCE,
  buildPlayFullHandPrompt,
} from "../src/protocol-knowledge.js";

// Every step keyword that MUST appear in BOTH static surfaces. These map 1:1 to
// the production state-machine tick() steps + their real tool names.
const STEP_KEYWORDS = [
  "register",
  "join_table", // FIX-A: seat creation, mandatory before publish_session_pk
  "publish_session_pk",
  "shuffle",
  "start_hand",
  "advance_phase",
  "decrypt",
  "hole_status", // FIX-C: hole-decrypt obligation discovery read tool
  "commit_action",
  "reveal_action",
  "invoke_showdown",
  "reset_crypto",
  "retry_tournament_finalize",
];

test("SERVER_INSTRUCTIONS contains every protocol step keyword", () => {
  for (const kw of STEP_KEYWORDS) {
    assert.ok(
      SERVER_INSTRUCTIONS.includes(kw),
      `SERVER_INSTRUCTIONS missing step keyword: ${kw}`,
    );
  }
});

test("PROTOCOL_SPEC_RESOURCE contains every protocol step keyword", () => {
  for (const kw of STEP_KEYWORDS) {
    assert.ok(
      PROTOCOL_SPEC_RESOURCE.includes(kw),
      `PROTOCOL_SPEC_RESOURCE missing step keyword: ${kw}`,
    );
  }
});

test("buildPlayFullHandPrompt interpolates all four args", () => {
  const args = {
    tableId: "0x" + "ab".repeat(32),
    tournamentId: "0x" + "cd".repeat(32),
    agentId: "424242",
    player: "0x1234567890123456789012345678901234567890",
  };
  const prompt = buildPlayFullHandPrompt(args);
  assert.ok(prompt.includes(args.tableId), "prompt missing tableId");
  assert.ok(prompt.includes(args.tournamentId), "prompt missing tournamentId");
  assert.ok(prompt.includes(args.agentId), "prompt missing agentId");
  assert.ok(prompt.includes(args.player), "prompt missing player");
});

test("play_full_hand prompt also drives every protocol step keyword", () => {
  const prompt = buildPlayFullHandPrompt({
    tableId: "0x" + "11".repeat(32),
    tournamentId: "0x" + "22".repeat(32),
    agentId: "1",
    player: "0x0000000000000000000000000000000000000001",
  });
  for (const kw of STEP_KEYWORDS) {
    assert.ok(prompt.includes(kw), `play_full_hand prompt missing step keyword: ${kw}`);
  }
});

// HONESTY GUARDS — no deleted tool, no false ZK claim, may not regress.
const FORBIDDEN_SUBSTRINGS = [
  "poker_finalize_tournament", // deleted in FIX-4 (finalize is automatic + retry rail)
  "115MB", // false ZK artifact footprint (real ~712MB; FIX-2)
  "auto-fetch", // ZK artifacts are EXPLICIT `pnpm fetch:zk`, never silent (FIX-2)
];

test("static surfaces contain no deleted tool or false ZK claim", () => {
  const prompt = buildPlayFullHandPrompt({
    tableId: "0x" + "33".repeat(32),
    tournamentId: "0x" + "44".repeat(32),
    agentId: "7",
    player: "0x0000000000000000000000000000000000000007",
  });
  for (const surface of [SERVER_INSTRUCTIONS, PROTOCOL_SPEC_RESOURCE, prompt]) {
    for (const bad of FORBIDDEN_SUBSTRINGS) {
      assert.ok(!surface.includes(bad), `forbidden substring present: ${bad}`);
    }
  }
});
