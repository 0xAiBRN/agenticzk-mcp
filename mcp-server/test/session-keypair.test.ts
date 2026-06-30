// F-12 — session keypair + joint-pk crypto. This is the foundation of mental
// poker: each agent derives (sk_i, pk_i) from a private seed, and the joint
// encryption key is Σ pk_i. Determinism matters — an agent must re-derive the
// exact same key across hands (F-06: keys are table-scoped, reused every hand).
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSessionKeypair, sumBabyJubPoints } from "../src/zk/shuffle-input.js";

test("deriveSessionKeypair is deterministic — same seed → same keypair", async () => {
  const a = await deriveSessionKeypair(123456789n);
  const b = await deriveSessionKeypair(123456789n);
  assert.equal(a.sk, b.sk);
  assert.deepEqual(a.pk, b.pk);
});

test("different seeds → different public keys", async () => {
  const a = await deriveSessionKeypair(111n);
  const b = await deriveSessionKeypair(222n);
  assert.notDeepEqual(a.pk, b.pk);
});

test("deriveSessionKeypair rejects a seed that reduces to sk = 0", async () => {
  await assert.rejects(() => deriveSessionKeypair(0n));
});

test("sumBabyJubPoints (joint pk = Σ pk_i) is order-independent", async () => {
  const a = await deriveSessionKeypair(10n);
  const b = await deriveSessionKeypair(20n);
  const c = await deriveSessionKeypair(30n);
  const s1 = await sumBabyJubPoints([a.pk, b.pk, c.pk]);
  const s2 = await sumBabyJubPoints([c.pk, a.pk, b.pk]);
  assert.deepEqual(s1, s2, "joint pk must not depend on contributor order");
});

test("sumBabyJubPoints of a single pk returns that pk", async () => {
  const a = await deriveSessionKeypair(777n);
  const s = await sumBabyJubPoints([a.pk]);
  assert.deepEqual(s, a.pk);
});
