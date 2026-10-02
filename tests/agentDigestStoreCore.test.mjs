import assert from "node:assert/strict";
import test from "node:test";

import { agentDigestCanonicalBytes } from "../lib/agentDigestCanonicalJson.ts";
import { classifyAgentDigestRepeat, prepareAgentDigestItem } from "../lib/agentDigestStoreCore.ts";

const submission = (overrides = {}) => ({
  agentKey: "qa-release",
  kind: "daily_digest",
  schemaVersion: 1,
  idempotencyKey: "qa-release:daily:2026-10-03",
  payload: { gates: { pending: 40 }, sha: "0123456789abcdef0123456789abcdef01234567" },
  ...overrides,
});

test("a valid submission is prepared with the canonical size and hash of the received value", () => {
  const result = prepareAgentDigestItem(submission());
  assert.equal(result.ok, true);
  const expected = agentDigestCanonicalBytes(submission().payload);
  assert.equal(result.row.sizeBytes, expected.sizeBytes);
  assert.equal(result.row.payloadSha256, expected.payloadSha256);
  assert.equal(result.row.idempotencyKey, "qa-release:daily:2026-10-03");
});

test("agent, kind and schema version come from closed lists and ranges", () => {
  assert.deepEqual(prepareAgentDigestItem(submission({ agentKey: "sre-ops" })), { ok: false, reason: "unknown_agent" });
  assert.deepEqual(prepareAgentDigestItem(submission({ agentKey: "__proto__" })), { ok: false, reason: "unknown_agent" });
  assert.deepEqual(prepareAgentDigestItem(submission({ kind: "page" })), { ok: false, reason: "unknown_kind" });
  for (const schemaVersion of [0, 1001, 1.5, Number.NaN]) {
    assert.deepEqual(prepareAgentDigestItem(submission({ schemaVersion })), {
      ok: false,
      reason: "schema_version_out_of_range",
    });
  }
});

test("the idempotency key carries the agent's prefix, a printable suffix and at most 200 characters", () => {
  for (const idempotencyKey of [
    "qa-release:",
    "sre-ops:x",
    "qa-releasex:1",
    "qa-release: space",
    "qa-release:é",
    `qa-release:${"x".repeat(190)}`,
    42,
  ]) {
    assert.deepEqual(
      prepareAgentDigestItem(submission({ idempotencyKey })),
      { ok: false, reason: "idempotency_key_invalid" },
      String(idempotencyKey).slice(0, 20),
    );
  }
  assert.equal(prepareAgentDigestItem(submission({ idempotencyKey: `qa-release:${"x".repeat(189)}` })).ok, true);
});

test("a payload that has no canonical bytes or exceeds 16 KiB is refused", () => {
  assert.deepEqual(prepareAgentDigestItem(submission({ payload: { n: 1.5 } })), {
    ok: false,
    reason: "payload_not_canonical",
  });
  assert.deepEqual(prepareAgentDigestItem(submission({ payload: { s: "x".repeat(16_384) } })), {
    ok: false,
    reason: "payload_too_large",
  });
  // Exactly the limit is admitted: {"s":"..."} is 8 bytes of framing.
  assert.equal(prepareAgentDigestItem(submission({ payload: { s: "x".repeat(16_384 - 8) } })).ok, true);
});

test("a credential anywhere in a key or string leaf is refused by rule id, never echoed", () => {
  const token = `ghp_${"A".repeat(36)}`;
  for (const payload of [{ note: token }, { list: [1, [token]] }, { [token]: 1 }]) {
    const result = prepareAgentDigestItem(submission({ payload }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "payload_contains_secret");
    assert.deepEqual(result.secretRuleIds, ["github-token"]);
    assert.equal(JSON.stringify(result).includes(token), false);
  }
});

test("a repeat under the same key is a replay only when the bytes, kind and version match", () => {
  const stored = { payloadSha256: "a".repeat(64), kind: "daily_digest", schemaVersion: 1 };
  assert.equal(classifyAgentDigestRepeat(stored, { ...stored }), "replayed");
  assert.equal(classifyAgentDigestRepeat(stored, { ...stored, payloadSha256: "b".repeat(64) }), "conflict");
  assert.equal(classifyAgentDigestRepeat(stored, { ...stored, schemaVersion: 2 }), "conflict");
});
