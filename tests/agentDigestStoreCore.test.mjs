import assert from "node:assert/strict";
import test from "node:test";

import { agentDigestCanonicalBytes } from "../lib/agentDigestCanonicalJson.ts";
import {
  AGENT_DIGEST_STORE_TIMEOUTS,
  classifyAgentDigestRepeat,
  prepareAgentDigestItem,
} from "../lib/agentDigestStoreCore.ts";

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
  assert.deepEqual(prepareAgentDigestItem(submission({ agentKey: "unregistered-agent" })), { ok: false, reason: "unknown_agent" });
  // A registered agent keeps to its own kinds.
  assert.deepEqual(prepareAgentDigestItem(submission({ agentKey: "sre-ops", kind: "price_deadline_digest" })), {
    ok: false,
    reason: "unknown_kind",
  });
  const sreOps = prepareAgentDigestItem(
    submission({ agentKey: "sre-ops", kind: "daily_digest", idempotencyKey: "sre-ops:digest:2026-10-08" }),
  );
  assert.equal(sreOps.ok, true, JSON.stringify(sreOps));
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
  assert.equal(classifyAgentDigestRepeat(stored, { ...stored, kind: "weekly_digest" }), "conflict");
});

test("a NUL character, which jsonb cannot hold, is refused before the transaction", () => {
  const nul = String.fromCharCode(0);
  for (const payload of [{ s: `a${nul}b` }, { [`k${nul}`]: 1 }, { list: [[nul]] }]) {
    assert.deepEqual(prepareAgentDigestItem(submission({ payload })), { ok: false, reason: "payload_not_canonical" });
  }
});

test("an assignment-shaped secret split across a key and its value is refused", () => {
  for (const payload of [{ API_TOKEN: "A1b2C3d4E5f6G7h8I9j0" }, { nested: [{ client_secret: "Zz9Yy8Xx7Ww6Vv5Uu4" }] }]) {
    const result = prepareAgentDigestItem(submission({ payload }));
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(result.reason, "payload_contains_secret");
  }
});

test("a credential in the idempotency key is refused before it can reach the audit chain", () => {
  const result = prepareAgentDigestItem(submission({ idempotencyKey: `qa-release:ghp_${"A".repeat(36)}` }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "payload_contains_secret");
  assert.deepEqual(result.secretRuleIds, ["github-token"]);
});

test("the submission transaction's limits are the policy's values, in the order Prisma > transaction > statement > idle", () => {
  const t = AGENT_DIGEST_STORE_TIMEOUTS;
  assert.deepEqual({ ...t }, { statementMs: 2000, idleMs: 1000, statements: 9, transactionMs: 32_000, prismaMs: 37_000 });
  assert.equal(t.transactionMs, (3 * t.statements + 5) * 1000);
  assert.ok(t.prismaMs > t.transactionMs && t.transactionMs > t.statementMs && t.statementMs > t.idleMs);
});

test("the prepared row holds an independent snapshot, not the caller's object", () => {
  const payload = { gates: { pending: 1 } };
  const result = prepareAgentDigestItem(submission({ payload }));
  assert.equal(result.ok, true);
  payload.gates.pending = 999;
  payload.token = `ghp_${"A".repeat(36)}`;
  assert.deepEqual(result.row.payload, { gates: { pending: 1 } });
  assert.notEqual(result.row.payload, payload);
});

test("a body that is not a JSON object is refused before any transaction", () => {
  for (const payload of [null, [], [1], "text", 7, true]) {
    assert.deepEqual(prepareAgentDigestItem(submission({ payload })), { ok: false, reason: "payload_not_canonical" }, JSON.stringify(payload));
  }
});

test("the writer takes the audit chain lock as its own statement, after the limits are armed", async () => {
  const { readFileSync } = await import("node:fs");
  const store = readFileSync(new URL("../lib/agentDigestStore.ts", import.meta.url), "utf8");
  // set_config arms statement_timeout for the statements after it, so a lock
  // folded into that same statement would wait without the 2 s limit.
  const setup = store.slice(store.indexOf("set_config('statement_timeout'"), store.indexOf("END`;"));
  assert.equal(setup.includes("pg_advisory"), false);
  const limitsAt = store.indexOf("set_config('statement_timeout'");
  const lockAt = store.indexOf("await takeAuditChainLock(tx);");
  const insertAt = store.indexOf("tx.agentDigestItem.createMany(");
  assert.ok(limitsAt > 0 && limitsAt < lockAt && lockAt < insertAt);
});
