// F-12 — MCP result envelope helpers. Every tool returns either okResult or
// errorResult; the agent's mcp-client parses these, so their shape is a
// contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { err, errorResult, okResult } from "../src/errors.js";

test("okResult wraps data as a single JSON text content block", () => {
  const r = okResult({ foo: 1, bar: "x" });
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0].type, "text");
  assert.deepEqual(JSON.parse(r.content[0].text), { foo: 1, bar: "x" });
  assert.notEqual((r as { isError?: boolean }).isError, true);
});

test("okResult serializes bigint values as decimal strings", () => {
  const r = okResult({ amount: 42n });
  assert.deepEqual(JSON.parse(r.content[0].text), { amount: "42" });
});

test("errorResult marks isError and carries the error body", () => {
  const r = errorResult(err("E_BAD_INPUT", "tableId malformed"));
  assert.equal(r.isError, true);
  const body = JSON.parse(r.content[0].text);
  assert.equal(body.code, "E_BAD_INPUT");
  assert.equal(body.message, "tableId malformed");
});

test("err omits the details key when no details are given", () => {
  assert.deepEqual(err("E_X", "msg"), { code: "E_X", message: "msg" });
  assert.deepEqual(err("E_Y", "msg", { seat: 3 }), {
    code: "E_Y",
    message: "msg",
    details: { seat: 3 },
  });
});
