import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const digest = await import("../lib/supportTriageDecisionDigest.ts");
const core = await import("../lib/supportTriageCore.ts");

// The decision digest keyring and envelope (docs/policy/support-triage.md §6).

const key = () => randomBytes(32).toString("base64url");
const HEX = "a".repeat(64);

const envelope = (overrides = {}) => ({
  envelopeVersion: 1,
  decisionKind: "suggestion_accepted",
  targetKind: "suggestion",
  targetBinding: HEX,
  policyVersion: 2,
  generatorVersions: { lane: "1", keywords: "1" },
  decidedAtSecond: 1_790_000_000,
  ...overrides,
});

const keyringOf = (env) => {
  const result = digest.readDigestKeyring(env);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.keyring;
};

test("a keyring needs a current version whose key is present and every key well formed", () => {
  const k1 = key();
  const k2 = key();
  const ring = keyringOf({
    SUPPORT_TRIAGE_DIGEST_KEY_V1: k1,
    SUPPORT_TRIAGE_DIGEST_KEY_V2: k2,
    SUPPORT_TRIAGE_DIGEST_KEY_CURRENT_VERSION: "2",
    UNRELATED: "x",
  });
  assert.equal(ring.currentVersion, 2);
  assert.deepEqual([...ring.keys.keys()].sort(), [1, 2]);

  const problem = (env) => {
    const result = digest.readDigestKeyring(env);
    assert.equal(result.ok, false);
    return result.problem;
  };
  assert.deepEqual(problem({ SUPPORT_TRIAGE_DIGEST_KEY_V1: k1 }), {
    reason: "current_version_missing",
    variable: "SUPPORT_TRIAGE_DIGEST_KEY_CURRENT_VERSION",
  });
  for (const version of ["0", "01", "v1", "1.5", "-1"]) {
    assert.equal(
      problem({ SUPPORT_TRIAGE_DIGEST_KEY_V1: k1, SUPPORT_TRIAGE_DIGEST_KEY_CURRENT_VERSION: version }).reason,
      "current_version_invalid",
      version
    );
  }
  assert.deepEqual(problem({ SUPPORT_TRIAGE_DIGEST_KEY_V1: k1, SUPPORT_TRIAGE_DIGEST_KEY_CURRENT_VERSION: "2" }), {
    reason: "current_key_missing",
    variable: "SUPPORT_TRIAGE_DIGEST_KEY_V2",
  });
  // Short, wrong alphabet, padded, a bad version suffix: each is the whole keyring's error.
  for (const [name, value] of [
    ["SUPPORT_TRIAGE_DIGEST_KEY_V1", randomBytes(31).toString("base64url")],
    ["SUPPORT_TRIAGE_DIGEST_KEY_V1", randomBytes(32).toString("base64")],
    ["SUPPORT_TRIAGE_DIGEST_KEY_V1", `${key()}=`],
    ["SUPPORT_TRIAGE_DIGEST_KEY_V1", "a".repeat(32)],
    ["SUPPORT_TRIAGE_DIGEST_KEY_Vx", key()],
    ["SUPPORT_TRIAGE_DIGEST_KEY_V1", ""],
  ]) {
    const result = problem({ [name]: value, SUPPORT_TRIAGE_DIGEST_KEY_V9: key(), SUPPORT_TRIAGE_DIGEST_KEY_CURRENT_VERSION: "9" });
    assert.deepEqual(result, { reason: "key_malformed", variable: name }, `${name}=${value.length}`);
  }
});

test("a problem names the variable and never carries a key", () => {
  const secret = randomBytes(31).toString("base64url");
  const result = digest.readDigestKeyring({ SUPPORT_TRIAGE_DIGEST_KEY_V1: secret, SUPPORT_TRIAGE_DIGEST_KEY_CURRENT_VERSION: "1" });
  assert.ok(!JSON.stringify(result).includes(secret));
});

test("a new digest uses the current key, and checks only with its own version's key", () => {
  const env = { SUPPORT_TRIAGE_DIGEST_KEY_V1: key(), SUPPORT_TRIAGE_DIGEST_KEY_V2: key(), SUPPORT_TRIAGE_DIGEST_KEY_CURRENT_VERSION: "1" };
  const v1 = digest.computeDecisionDigest(keyringOf(env), envelope());
  assert.equal(v1.digestVersion, 1);
  assert.match(v1.decisionEnvelopeDigest, /^[0-9a-f]{64}$/);

  // Rotated: new records use V2, old ones still check with V1.
  const rotated = keyringOf({ ...env, SUPPORT_TRIAGE_DIGEST_KEY_CURRENT_VERSION: "2" });
  assert.equal(digest.computeDecisionDigest(rotated, envelope()).digestVersion, 2);
  assert.equal(digest.verifyDecisionDigest(rotated, envelope(), v1), "match");
  assert.equal(digest.verifyDecisionDigest(rotated, envelope({ targetBinding: "b".repeat(64) }), v1), "mismatch");
  assert.equal(digest.verifyDecisionDigest(rotated, envelope(), { ...v1, decisionEnvelopeDigest: "zz" }), "mismatch");

  // V1 retired: its records are unverifiable, not mismatched and not recomputed.
  const retired = keyringOf({ SUPPORT_TRIAGE_DIGEST_KEY_V2: env.SUPPORT_TRIAGE_DIGEST_KEY_V2, SUPPORT_TRIAGE_DIGEST_KEY_CURRENT_VERSION: "2" });
  assert.equal(digest.verifyDecisionDigest(retired, envelope(), v1), "unverifiable");
});

test("the digest is keyed: the same envelope under another key differs", () => {
  const a = digest.computeDecisionDigest(keyringOf({ SUPPORT_TRIAGE_DIGEST_KEY_V1: key(), SUPPORT_TRIAGE_DIGEST_KEY_CURRENT_VERSION: "1" }), envelope());
  const b = digest.computeDecisionDigest(keyringOf({ SUPPORT_TRIAGE_DIGEST_KEY_V1: key(), SUPPORT_TRIAGE_DIGEST_KEY_CURRENT_VERSION: "1" }), envelope());
  assert.notEqual(a.decisionEnvelopeDigest, b.decisionEnvelopeDigest);
});

test("the envelope is exact: no extra field, matching target, a hex binding", () => {
  const ring = keyringOf({ SUPPORT_TRIAGE_DIGEST_KEY_V1: key(), SUPPORT_TRIAGE_DIGEST_KEY_CURRENT_VERSION: "1" });
  for (const bad of [
    envelope({ feedbackId: "fb-1" }),
    envelope({ decisionKind: "group_confirmed" }),
    envelope({ targetBinding: "not-hex" }),
    envelope({ envelopeVersion: 2 }),
    envelope({ policyVersion: 0 }),
    envelope({ decidedAtSecond: 1.5 }),
    envelope({ generatorVersions: { lane: "free text with spaces" } }),
  ]) {
    assert.throws(() => digest.computeDecisionDigest(ring, bad), RangeError, JSON.stringify(bad));
  }
  const { decisionKind, ...missing } = envelope();
  assert.ok(decisionKind);
  assert.throws(() => digest.computeDecisionDigest(ring, missing), RangeError);
});

test("canonical JSON sorts keys at every depth, so field order never changes the digest", () => {
  assert.equal(digest.canonicalJson({ b: 1, a: { d: [2, 1], c: null } }), '{"a":{"c":null,"d":[2,1]},"b":1}');
  const ring = keyringOf({ SUPPORT_TRIAGE_DIGEST_KEY_V1: key(), SUPPORT_TRIAGE_DIGEST_KEY_CURRENT_VERSION: "1" });
  const reordered = Object.fromEntries(Object.entries(envelope()).reverse());
  assert.equal(
    digest.computeDecisionDigest(ring, reordered).decisionEnvelopeDigest,
    digest.computeDecisionDigest(ring, envelope()).decisionEnvelopeDigest
  );
});

test("a group binding covers the member set and the group's input digest, not their order", () => {
  const one = digest.groupTargetBinding(["fb-b", "fb-a"], HEX);
  assert.equal(one, digest.groupTargetBinding(["fb-a", "fb-b"], HEX));
  assert.notEqual(one, digest.groupTargetBinding(["fb-a", "fb-b"], "c".repeat(64)));
  assert.notEqual(one, digest.groupTargetBinding(["fb-a", "fb-c"], HEX));
  assert.throws(() => digest.groupTargetBinding([], HEX), RangeError);
  assert.throws(() => digest.groupTargetBinding(["fb-a", "fb-a"], HEX), RangeError);
});

test("the migration's decision kinds, retention and link cap are the core's", () => {
  const sql = readFileSync(
    new URL("../prisma/migrations/20261005010000_support_triage_decision_record/migration.sql", import.meta.url),
    "utf8"
  );
  const list = core.DECISION_KINDS.map((kind) => `'${kind}'`).join(", ");
  assert.ok(sql.includes(`CHECK ("decisionKind" IN (${list}))`));
  assert.ok(sql.includes(`"decidedAt" + INTERVAL '${core.DECISION_RECORD_RETENTION_MONTHS} months'`));
  assert.ok(sql.includes(`retention CONSTANT INTERVAL := interval '${core.DECISION_RECORD_RETENTION_MONTHS} months'`));
  assert.ok(sql.includes(`link_cap CONSTANT INTEGER := ${core.DECISION_RECORD_LINKS_MAX};`));
});
