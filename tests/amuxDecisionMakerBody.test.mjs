// AMUX Decision Maker policy version 1, stage S1d: the body store, its
// retention and its digest keys (docs/policy/amux-decision-maker.md §10, with
// §6 and §9 where they meet it).
//
// Runs without a database: the vocabularies and their parity with the
// migration's CHECKs and triggers, the byte caps, the retention and key-period
// arithmetic, the open-hold rule, the keyed digests (pinned against an
// independent HMAC of the documented layout), the key ring, the one-writer
// rule, and the exact statements each store operation sends (§9's statement
// budget), counted on a recording transaction. What the database itself
// refuses is exercised against PostgreSQL in
// tests/integration/amux-decision-maker-body.db.test.ts.

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import {
  DM_ANSWER_MAX_BYTES,
  DM_CARD_TEXT_MAX_BYTES,
  DM_ESCALATION_MAX_BYTES,
  DM_RATIONALE_MAX_BYTES,
} from "../lib/amux/decisionMakerCore.ts";
import {
  DM_BODY_AUDIT_ACTIONS,
  DM_BODY_AUDIT_METADATA_KEYS,
  DM_BODY_FIELDS,
  DM_BODY_FIELD_MAX_BYTES,
  DM_BODY_REQUEST_MAX_BYTES,
  DM_DIGEST_KEY_BYTES,
  DM_DIGEST_KEY_EVENT_KINDS,
  DM_HOLD_EVENT_KINDS,
  DM_KEY_PERIOD_MS,
  DM_OPERATOR_ANSWER_MAX_BYTES,
  DM_RETENTION_ACTOR_KINDS,
  DM_RETENTION_AFTER_CLOSE_MS,
  DM_RETENTION_EVENT_KINDS,
  dmBodiesRefusal,
  dmBodyAuditMetadata,
  dmBodyDigest,
  dmBodyRefusal,
  dmBodyRetentionStateFromRow,
  dmDigestKeyCheck,
  dmDigestKeyDestroyRefusal,
  dmDigestKeyPeriodStateFromRow,
  dmDigestKeyRotateRefusal,
  dmDigestKeyUsable,
  dmEraseRefusal,
  dmHoldOpen,
  dmHoldRefusal,
  dmKeyPeriodEndMs,
  dmKeyPeriodOf,
  dmKeyPeriodStartMs,
  dmOutputBodies,
  dmPayloadDigest,
  dmPurgeRefusal,
  dmRequestDigestKey,
  dmResultDigest,
  dmRetentionUntilMs,
  dmSnapshotManifestDigest,
} from "../lib/amux/decisionMakerBodyCore.ts";
import {
  DecisionMakerBodyWriteError,
  assignDecisionMakerRequestWithDigestKey,
  destroyDecisionMakerDigestKey,
  eraseDecisionMakerBodies,
  listDecisionMakerPurgeCandidates,
  purgeDecisionMakerBodies,
  readDecisionMakerBodies,
  readDecisionMakerBodyRetention,
  readDecisionMakerDigestKeyPeriod,
  recordDecisionMakerLegalHold,
  rotateDecisionMakerDigestKey,
  submitDecisionMakerOutput,
} from "../lib/amux/decisionMakerBodyStore.ts";
import {
  DM_DIGEST_KEYS_ENV,
  DecisionMakerDigestKeyError,
  decisionMakerPeriodKey,
  loadDecisionMakerDigestKeyRing,
  parseDecisionMakerDigestKeyRing,
} from "../lib/amux/decisionMakerDigestKeys.ts";
import {
  DM_ASSIGNMENT_WINDOW_MS,
  DM_CLOSING_EVENT_KINDS,
  DM_STALE_CLOSE_AFTER_MS,
} from "../lib/amux/decisionMakerRequestCore.ts";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const STORE = "lib/amux/decisionMakerBodyStore.ts";
const CORE = "lib/amux/decisionMakerBodyCore.ts";
const KEYS = "lib/amux/decisionMakerDigestKeys.ts";
const AUDIT_MODULE = "lib/amux/decisionMakerBodySystemAudit.ts";
const MIGRATION = "prisma/migrations/20261008120000_amux_decision_maker_body_store/migration.sql";
const LEDGER_MIGRATION = "prisma/migrations/20261008090100_amux_decision_maker_request_ledger/migration.sql";

const withoutSqlComments = (sql) =>
  sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

const quoted = (text) => [...text.matchAll(/'([^']*)'/g)].map((item) => item[1]);

const checkBody = (sql, name) => {
  const start = sql.indexOf(`CONSTRAINT "${name}"`);
  assert.ok(start >= 0, `CHECK ${name} was found`);
  const open = sql.indexOf("CHECK", start);
  let depth = 0;
  for (let index = sql.indexOf("(", open); index < sql.length; index += 1) {
    if (sql[index] === "(") depth += 1;
    if (sql[index] === ")") depth -= 1;
    if (depth === 0) return sql.slice(open, index + 1);
  }
  throw new Error(`unbalanced CHECK ${name}`);
};

const functionBody = (sql, name) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION "${name}"`);
  assert.ok(start >= 0, `function ${name} was found`);
  const bodyStart = sql.indexOf("AS $$", start);
  const bodyEnd = sql.indexOf("$$;", bodyStart + 5);
  return sql.slice(start, bodyEnd + 3);
};

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Vocabularies and caps
// ---------------------------------------------------------------------------

test("section 10's five body fields, their caps, and the 40 KiB a request can never reach", () => {
  assert.deepEqual([...DM_BODY_FIELDS], ["card_text", "dm_answer", "dm_rationale", "dm_escalation_reason", "operator_answer"]);
  assert.deepEqual(DM_BODY_FIELD_MAX_BYTES, {
    card_text: 16 * 1024,
    dm_answer: 8 * 1024,
    dm_rationale: 4 * 1024,
    dm_escalation_reason: 1024,
    operator_answer: 8 * 1024,
  });
  // The DM output caps are S1a's and the card cap is section 5's: one number each.
  assert.equal(DM_BODY_FIELD_MAX_BYTES.card_text, DM_CARD_TEXT_MAX_BYTES);
  assert.equal(DM_BODY_FIELD_MAX_BYTES.dm_answer, DM_ANSWER_MAX_BYTES);
  assert.equal(DM_BODY_FIELD_MAX_BYTES.dm_rationale, DM_RATIONALE_MAX_BYTES);
  assert.equal(DM_BODY_FIELD_MAX_BYTES.dm_escalation_reason, DM_ESCALATION_MAX_BYTES);
  assert.equal(DM_BODY_FIELD_MAX_BYTES.operator_answer, DM_OPERATOR_ANSWER_MAX_BYTES);
  assert.equal(DM_BODY_REQUEST_MAX_BYTES, 40 * 1024);
  // One row per field per request: the five caps together stay under section 10's total.
  const sum = Object.values(DM_BODY_FIELD_MAX_BYTES).reduce((total, cap) => total + cap, 0);
  assert.equal(sum, 37 * 1024);
  assert.ok(sum <= DM_BODY_REQUEST_MAX_BYTES);
});

test("the retention, hold and key vocabularies are section 10's", () => {
  assert.deepEqual([...DM_RETENTION_EVENT_KINDS], ["retention_set", "hold_set", "hold_release"]);
  assert.deepEqual([...DM_HOLD_EVENT_KINDS], ["hold_set", "hold_release"]);
  assert.deepEqual([...DM_RETENTION_ACTOR_KINDS], ["human", "system"]);
  assert.deepEqual([...DM_DIGEST_KEY_EVENT_KINDS], ["rotate", "destroy"]);
  assert.equal(DM_RETENTION_AFTER_CLOSE_MS, 90 * DAY);
  assert.equal(DM_KEY_PERIOD_MS, 30 * DAY);
  assert.equal(DM_DIGEST_KEY_BYTES, 32);
  assert.deepEqual(DM_BODY_AUDIT_ACTIONS, {
    legalHold: "amux.decision.legal_hold",
    bodyErase: "amux.decision.body_erase",
    bodyPurge: "amux.decision.body_purge",
    digestKeyRotate: "amux.decision.digest_key_rotate",
    digestKeyDestroy: "amux.decision.digest_key_destroy",
  });
  // Section 10: "hold가 없으면 본문은 길어야 120일 남고" -- a stale close at 30
  // days from creation plus the retention.
  assert.equal(DM_STALE_CLOSE_AFTER_MS + DM_RETENTION_AFTER_CLOSE_MS, 120 * DAY);
});

// ---------------------------------------------------------------------------
// The migration holds the same numbers and lists
// ---------------------------------------------------------------------------

test("the migration's CHECKs hold the core's lists and caps", () => {
  const sql = read(MIGRATION);
  assert.deepEqual(quoted(checkBody(sql, "AmuxDecisionMakerBody_field_check")), [...DM_BODY_FIELDS]);
  const sizes = checkBody(sql, "AmuxDecisionMakerBody_text_size_check");
  const caps = Object.fromEntries([...sizes.matchAll(/WHEN '([a-z_]+)' THEN (\d+)/g)].map((match) => [match[1], Number(match[2])]));
  assert.deepEqual(caps, DM_BODY_FIELD_MAX_BYTES);
  assert.match(sizes, /octet_length\("text"\) >= 1/);
  assert.match(sizes, /ELSE 0/);
  assert.deepEqual(quoted(checkBody(sql, "AmuxDecisionMakerRetentionEvent_kind_check")), [...DM_RETENTION_EVENT_KINDS]);
  assert.deepEqual(quoted(checkBody(sql, "AmuxDecisionMakerRetentionEvent_actor_kind_check")), [...DM_RETENTION_ACTOR_KINDS]);
  assert.deepEqual(quoted(checkBody(sql, "AmuxDecisionMakerDigestKeyEvent_kind_check")), [...DM_DIGEST_KEY_EVENT_KINDS]);
  // One retention per request, one rotation and one destruction per period, one body per field.
  assert.match(sql, /"AmuxDecisionMakerRetentionEvent_one_retention_key"\s+ON "AmuxDecisionMakerRetentionEvent"\("requestId"\) WHERE "kind" = 'retention_set'/);
  assert.match(sql, /"AmuxDecisionMakerDigestKeyEvent_one_rotate_key"\s+ON "AmuxDecisionMakerDigestKeyEvent"\("keyPeriod"\) WHERE "kind" = 'rotate'/);
  assert.match(sql, /"AmuxDecisionMakerDigestKeyEvent_one_destroy_key"\s+ON "AmuxDecisionMakerDigestKeyEvent"\("keyPeriod"\) WHERE "kind" = 'destroy'/);
  assert.match(sql, /"AmuxDecisionMakerBody_requestId_field_key"\s+ON "AmuxDecisionMakerBody"\("requestId", "field"\)/);
});

test("the triggers use the core's period, retention, total and actions, and the ledger's lock", () => {
  const sql = withoutSqlComments(read(MIGRATION));
  // floor(epoch ms / 2,592,000,000) everywhere a key period is derived.
  const periods = [...sql.matchAll(/\* 1000 \/ (\d+)\)::INTEGER/g)].map((match) => Number(match[1]));
  assert.ok(periods.length >= 4);
  assert.ok(periods.every((value) => value === DM_KEY_PERIOD_MS));
  assert.deepEqual([...sql.matchAll(/\$1(?: \+ 1\))?::double precision \* (\d+)/g)].map((match) => Number(match[1]) * 1000), [
    DM_KEY_PERIOD_MS,
    DM_KEY_PERIOD_MS,
  ]);
  // One in the retention guard, one (quoted twice) in the closing trigger's format string.
  assert.equal([...sql.matchAll(/INTERVAL '{1,2}90 days'{1,2}/g)].length, 2);
  assert.match(functionBody(sql, "amux_decision_maker_body_guard"), new RegExp(`> ${DM_BODY_REQUEST_MAX_BYTES} THEN`));
  for (const action of Object.values(DM_BODY_AUDIT_ACTIONS)) {
    if (action.startsWith("amux.decision.digest_key_")) continue;
    assert.ok(sql.includes(`'${action}'`), action);
  }
  assert.match(functionBody(sql, "amux_decision_maker_digest_key_event_guard"), /'amux\.decision\.digest_key_' \|\| NEW\."kind"/);
  // The request lock is the S1c event guard's own key, so ledger, retention and body writes of a request serialize.
  const ledger = read(LEDGER_MIGRATION);
  assert.ok(ledger.includes("'tomverse-amux-decision-maker-request:' || NEW.\"requestId\""));
  for (const name of ["amux_decision_maker_body_guard", "amux_decision_maker_retention_event_guard"]) {
    assert.ok(functionBody(sql, name).includes("'tomverse-amux-decision-maker-request:' ||"), name);
  }
  // The closing trigger fires on exactly the ledger's closing kinds.
  assert.match(sql, new RegExp(`WHEN \\(NEW\\."kind" IN \\(${DM_CLOSING_EVENT_KINDS.map((kind) => `'${kind}'`).join(", ")}\\)\\)`));
  assert.match(sql, /AFTER INSERT ON "AmuxDecisionMakerRequestEvent"/);
});

test("every guard refuses an update, reads only under READ COMMITTED, pins search_path and sets its clock", () => {
  const sql = read(MIGRATION);
  for (const [name, immutable, isolation] of [
    ["amux_decision_maker_body_guard", "AMUX_DM_BODY_IMMUTABLE", "AMUX_DM_BODY_ISOLATION"],
    ["amux_decision_maker_retention_event_guard", "AMUX_DM_RETENTION_IMMUTABLE", "AMUX_DM_RETENTION_ISOLATION"],
    ["amux_decision_maker_digest_key_event_guard", "AMUX_DM_DIGEST_KEY_IMMUTABLE", "AMUX_DM_DIGEST_KEY_ISOLATION"],
  ]) {
    const body = functionBody(sql, name);
    assert.ok(body.includes(`RAISE EXCEPTION '${immutable}'`), name);
    assert.ok(body.includes(`RAISE EXCEPTION '${isolation}'`), name);
    assert.ok(body.includes("SET search_path = pg_catalog, pg_temp"), name);
    assert.ok(body.includes('NEW."createdAt" := pg_catalog.clock_timestamp();'), name);
    assert.match(sql, new RegExp(`CREATE TRIGGER "${name}"\\s+BEFORE INSERT OR UPDATE OR DELETE ON`), name);
  }
  // Only the body table allows a delete at all; the retention and key tables refuse any non-insert.
  assert.ok(functionBody(sql, "amux_decision_maker_body_guard").includes("IF TG_OP = 'UPDATE' THEN"));
  for (const name of ["amux_decision_maker_retention_event_guard", "amux_decision_maker_digest_key_event_guard"]) {
    assert.ok(functionBody(sql, name).includes("IF TG_OP <> 'INSERT' THEN"), name);
  }
  assert.ok(functionBody(sql, "amux_decision_maker_request_closing_retention").includes("SET search_path = pg_catalog, pg_temp"));
  // No guard reads the switches: everything here stays allowed under the kill switch (section 6's table).
  assert.doesNotMatch(withoutSqlComments(sql), /AmuxDecisionMakerSwitchEvent|switch-gate/);
  // Additive only.
  assert.doesNotMatch(withoutSqlComments(sql), /\bDROP\b|ALTER TABLE "AmuxDecisionMakerRequest(Event)?"|ALTER TABLE "AmuxDecisionMakerSwitchEvent"/);
});

// ---------------------------------------------------------------------------
// Key periods and digests
// ---------------------------------------------------------------------------

test("a key period is whole 30-day periods since the epoch, by the database clock", () => {
  assert.equal(dmKeyPeriodOf(0), 0);
  assert.equal(dmKeyPeriodOf(DM_KEY_PERIOD_MS - 1), 0);
  assert.equal(dmKeyPeriodOf(DM_KEY_PERIOD_MS), 1);
  const instant = Date.parse("2026-10-08T00:00:00.000Z");
  const period = dmKeyPeriodOf(instant);
  assert.equal(period, 691);
  assert.ok(dmKeyPeriodStartMs(period) <= instant && instant < dmKeyPeriodEndMs(period));
  assert.equal(dmKeyPeriodEndMs(period) - dmKeyPeriodStartMs(period), DM_KEY_PERIOD_MS);
  // Whole seconds: the migration's to_timestamp(period * 2,592,000) is exact.
  assert.equal(dmKeyPeriodStartMs(period) % 1000, 0);
  for (const bad of [-1, 1.5, Number.NaN, Number.MAX_VALUE]) {
    assert.throws(() => dmKeyPeriodOf(bad));
  }
});

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const REQUEST_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_REQUEST_ID = "22222222-2222-4333-8444-555555555555";
const hmacHex = (key, ...parts) => {
  const mac = createHmac("sha256", key);
  mac.update(Buffer.from(parts.join("\0"), "utf8"));
  return mac.digest("hex");
};

test("the digests are HMAC-SHA256 of the documented layout, never a plain hash", () => {
  assert.equal(dmDigestKeyCheck(KEY), hmacHex(KEY, "amux-dm-digest-key-check-v1"));
  const requestKey = dmRequestDigestKey(KEY, REQUEST_ID);
  assert.equal(requestKey.toString("hex"), hmacHex(KEY, "amux-dm-request-key-v1", REQUEST_ID));
  assert.equal(requestKey.length, 32);
  assert.equal(dmBodyDigest(requestKey, "dm_answer", "Use the model id."), hmacHex(requestKey, "amux-dm-body-v1", "dm_answer", "Use the model id."));
  assert.equal(dmPayloadDigest(requestKey, "payload bytes"), hmacHex(requestKey, "amux-dm-payload-v1", "payload bytes"));
  assert.equal(dmPayloadDigest(requestKey, Buffer.from("payload bytes")), dmPayloadDigest(requestKey, "payload bytes"));
  assert.equal(dmResultDigest(requestKey, { kind: "output", raw: "{}" }), hmacHex(requestKey, "amux-dm-result-v1", "output", "{}"));
  assert.equal(dmResultDigest(requestKey, { kind: "timeout" }), hmacHex(requestKey, "amux-dm-result-v1", "timeout"));
  assert.equal(
    dmSnapshotManifestDigest(requestKey, [{ path: "lib/b.ts", blobId: "b".repeat(40) }, { path: "lib/a.ts", blobId: "a".repeat(40) }]),
    hmacHex(requestKey, "amux-dm-manifest-v1", "lib/a.ts", "a".repeat(40), "lib/b.ts", "b".repeat(40)),
  );
  for (const digest of [dmBodyDigest(requestKey, "dm_answer", "x"), dmDigestKeyCheck(KEY), dmResultDigest(requestKey, { kind: "unavailable" })]) {
    assert.match(digest, /^[0-9a-f]{64}$/);
  }
  // Never the plain SHA-256 of a body.
  assert.notEqual(dmBodyDigest(requestKey, "dm_answer", "yes"), createHash("sha256").update("yes").digest("hex"));
  for (const path of [CORE, STORE, KEYS]) {
    assert.doesNotMatch(read(path), /createHash\(/, path);
  }
  // A short key is refused, not padded.
  assert.throws(() => dmDigestKeyCheck(Buffer.alloc(16)));
});

test("every digest is bound to its request, its field and its label", () => {
  const one = dmRequestDigestKey(KEY, REQUEST_ID);
  const two = dmRequestDigestKey(KEY, OTHER_REQUEST_ID);
  assert.notDeepEqual(one, two);
  // The same answer in two requests, or in two fields, does not digest alike.
  assert.notEqual(dmBodyDigest(one, "dm_answer", "yes"), dmBodyDigest(two, "dm_answer", "yes"));
  assert.notEqual(dmBodyDigest(one, "dm_answer", "yes"), dmBodyDigest(one, "operator_answer", "yes"));
  // Labels separate the kinds of digest over the same bytes.
  assert.notEqual(dmPayloadDigest(one, "x"), dmResultDigest(one, { kind: "output", raw: "x" }));
  assert.notEqual(dmResultDigest(one, { kind: "timeout" }), dmResultDigest(one, { kind: "unavailable" }));
  // Another period's key derives other request keys and another check value.
  assert.notDeepEqual(dmRequestDigestKey(OTHER_KEY, REQUEST_ID), one);
  assert.notEqual(dmDigestKeyCheck(OTHER_KEY), dmDigestKeyCheck(KEY));
  // Deterministic: a retried submission in the same request digests identically.
  assert.equal(dmResultDigest(dmRequestDigestKey(KEY, REQUEST_ID), { kind: "output", raw: "{}" }), dmResultDigest(one, { kind: "output", raw: "{}" }));
  // The manifest digest does not depend on the order the broker listed it in.
  const entries = [{ path: "a", blobId: "1".repeat(40) }, { path: "b", blobId: "2".repeat(40) }];
  assert.equal(dmSnapshotManifestDigest(one, entries), dmSnapshotManifestDigest(one, [...entries].reverse()));
});

// ---------------------------------------------------------------------------
// The key ring
// ---------------------------------------------------------------------------

const b64 = (byte) => Buffer.alloc(32, byte).toString("base64");

test("the key ring reads one key per period from the secret, and refuses all of it on any fault", () => {
  const ring = parseDecisionMakerDigestKeyRing(`690:${b64(1)}, 691:${b64(2)}`);
  assert.deepEqual([...ring.keys()], [690, 691]);
  assert.deepEqual(decisionMakerPeriodKey(ring, 691), Buffer.alloc(32, 2));
  assert.equal(decisionMakerPeriodKey(ring, 692), null);
  assert.equal(decisionMakerPeriodKey(ring, -1), null);
  assert.equal(DM_DIGEST_KEYS_ENV, "AMUX_DM_DIGEST_KEYS");
  assert.deepEqual([...loadDecisionMakerDigestKeyRing({ AMUX_DM_DIGEST_KEYS: `0:${b64(3)}` }).keys()], [0]);
  for (const [value, code] of [
    [undefined, "not_configured"],
    ["  ", "not_configured"],
    [`690:${b64(1)},690:${b64(2)}`, "malformed"],
    [`690:${b64(1)},691:${b64(1)}`, "malformed"],
    [`0690:${b64(1)}`, "malformed"],
    [`-1:${b64(1)}`, "malformed"],
    [`690:${Buffer.alloc(16, 1).toString("base64")}`, "malformed"],
    [`690:${b64(1)},`, "malformed"],
    [`690=${b64(1)}`, "malformed"],
  ]) {
    assert.throws(
      () => parseDecisionMakerDigestKeyRing(value),
      (error) => {
        assert.ok(error instanceof DecisionMakerDigestKeyError);
        assert.equal(error.code, code);
        // The error names the fault, never a value.
        assert.ok(!String(error.message).includes(b64(1)));
        return true;
      },
      String(value),
    );
  }
});

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

test("a body is refused for an unknown field, no text, malformed text, its cap in bytes, or a secret", () => {
  assert.equal(dmBodyRefusal("dm_answer", "Use the model id only."), null);
  assert.equal(dmBodyRefusal("dm_verdict", "x"), "unknown_field");
  assert.equal(dmBodyRefusal("dm_answer", ""), "empty");
  assert.equal(dmBodyRefusal("dm_answer", 42), "empty");
  assert.equal(dmBodyRefusal("dm_answer", "a\u0000b"), "not_well_formed");
  assert.equal(dmBodyRefusal("dm_answer", "a\ud800b"), "not_well_formed");
  // Bytes, not characters: 1,024 three-byte characters are 3,072 bytes.
  assert.equal(dmBodyRefusal("dm_escalation_reason", "가".repeat(341)), null);
  assert.equal(dmBodyRefusal("dm_escalation_reason", "가".repeat(342)), "too_long");
  for (const field of DM_BODY_FIELDS) {
    const cap = DM_BODY_FIELD_MAX_BYTES[field];
    assert.equal(dmBodyRefusal(field, "x".repeat(cap)), null, field);
    assert.equal(dmBodyRefusal(field, "x".repeat(cap + 1)), "too_long", field);
  }
  // The router's own scanner: a credential in a body is never stored.
  assert.equal(dmBodyRefusal("operator_answer", "Use ghp_0123456789abcdefghijklmnopqrstuvwxyzAB"), "secret_detected");
  // The total, with what the request already has.
  assert.equal(dmBodiesRefusal([{ field: "dm_answer", text: "a" }]), null);
  assert.equal(dmBodiesRefusal([{ field: "dm_answer", text: "a" }], DM_BODY_REQUEST_MAX_BYTES), "request_too_long");
  assert.equal(dmBodiesRefusal([{ field: "dm_answer", text: "" }]), "empty");
});

test("a DM output stores exactly the fields of its kind", () => {
  assert.deepEqual(dmOutputBodies({ kind: "select", optionId: "a", rationale: "Because.", irreversible: false }), [
    { field: "dm_rationale", text: "Because." },
  ]);
  assert.deepEqual(dmOutputBodies({ kind: "free_text", answer: "Do X.", rationale: "Because.", irreversible: true }), [
    { field: "dm_answer", text: "Do X." },
    { field: "dm_rationale", text: "Because." },
  ]);
  assert.deepEqual(dmOutputBodies({ kind: "escalate", reason: "Needs a person." }), [
    { field: "dm_escalation_reason", text: "Needs a person." },
  ]);
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

const NOW = 1_790_000_000_000;
const retentionRow = (overrides = {}) => ({
  dbNowEpochMs: BigInt(NOW),
  retentionUntilEpochMs: null,
  holdSets: 0n,
  holdReleases: 0n,
  bodyFields: [],
  bodyBytes: 0n,
  ...overrides,
});
const retention = (overrides = {}) => {
  const state = dmBodyRetentionStateFromRow(REQUEST_ID, retentionRow(overrides));
  assert.ok(state);
  return state;
};

test("retention runs 90 days from the close, and an open hold is more hold_set than hold_release", () => {
  assert.equal(dmRetentionUntilMs(NOW), NOW + 90 * DAY);
  assert.equal(dmHoldOpen(0, 0), false);
  assert.equal(dmHoldOpen(1, 0), true);
  assert.equal(dmHoldOpen(1, 1), false);
  assert.equal(dmHoldOpen(2, 1), true);
  // retention_set is not a hold event and never counts.
  const closed = retention({ retentionUntilEpochMs: BigInt(NOW + DAY), bodyFields: ["dm_rationale", "card_text"] });
  assert.equal(closed.holdOpen, false);
  assert.deepEqual(closed.bodyFields, ["card_text", "dm_rationale"]);
  assert.equal(retention({ holdSets: 2n, holdReleases: 1n }).holdOpen, true);
});

test("a hold is set only when none is open and released only when one is", () => {
  assert.equal(dmHoldRefusal(retention(), "set"), null);
  assert.equal(dmHoldRefusal(retention(), "release"), "no_open_hold");
  assert.equal(dmHoldRefusal(retention({ holdSets: 1n }), "set"), "hold_open");
  assert.equal(dmHoldRefusal(retention({ holdSets: 1n }), "release"), null);
  assert.equal(dmHoldRefusal(retention({ holdSets: 1n, holdReleases: 1n }), "set"), null);
});

test("an expiry purge needs a close, the retention passed, no open hold and a body; an erase only no open hold", () => {
  const bodies = { bodyFields: ["dm_rationale"], bodyBytes: 10n };
  assert.equal(dmPurgeRefusal(retention(bodies)), "not_closed");
  assert.equal(dmPurgeRefusal(retention({ ...bodies, retentionUntilEpochMs: BigInt(NOW + 1) })), "retained");
  assert.equal(dmPurgeRefusal(retention({ ...bodies, retentionUntilEpochMs: BigInt(NOW), holdSets: 1n })), "held");
  assert.equal(dmPurgeRefusal(retention({ retentionUntilEpochMs: BigInt(NOW) })), "no_bodies");
  assert.equal(dmPurgeRefusal(retention({ ...bodies, retentionUntilEpochMs: BigInt(NOW) })), null);
  // The privacy erase is section 10's one exception: before the retention, but never under a hold.
  assert.equal(dmEraseRefusal(retention(bodies), ["dm_rationale"]), null);
  assert.equal(dmEraseRefusal(retention({ ...bodies, holdSets: 1n }), ["dm_rationale"]), "held");
  assert.equal(dmEraseRefusal(retention(bodies), ["card_text"]), "no_bodies");
});

test("a retention row the tables could not have produced is unreadable", () => {
  for (const overrides of [
    { dbNowEpochMs: null },
    { holdSets: -1n },
    { holdReleases: "x" },
    { bodyFields: ["dm_verdict"] },
    { bodyFields: ["dm_answer", "dm_answer"] },
    { bodyFields: "dm_answer" },
    { retentionUntilEpochMs: "soon" },
    { bodyBytes: null },
  ]) {
    assert.equal(dmBodyRetentionStateFromRow(REQUEST_ID, retentionRow(overrides)), null, JSON.stringify(overrides, (_, v) => (typeof v === "bigint" ? String(v) : v)));
  }
  assert.equal(dmBodyRetentionStateFromRow(REQUEST_ID, null), null);
});

// ---------------------------------------------------------------------------
// The key registry
// ---------------------------------------------------------------------------

const CURRENT = dmKeyPeriodOf(NOW);
const keyRow = (overrides = {}) => ({
  dbNowEpochMs: BigInt(NOW),
  keyCheck: null,
  destroyed: false,
  bodies: 0n,
  heldRequests: 0n,
  ...overrides,
});
const keyState = (period, overrides = {}) => {
  const state = dmDigestKeyPeriodStateFromRow(period, keyRow(overrides));
  assert.ok(state);
  return state;
};
const CHECK = dmDigestKeyCheck(KEY);

test("a key period is rotated in once, never after its destruction, no further ahead than the next", () => {
  assert.equal(keyState(CURRENT).currentKeyPeriod, CURRENT);
  assert.equal(dmDigestKeyRotateRefusal(keyState(CURRENT)), null);
  assert.equal(dmDigestKeyRotateRefusal(keyState(CURRENT + 1)), null);
  assert.equal(dmDigestKeyRotateRefusal(keyState(CURRENT - 5)), null);
  assert.equal(dmDigestKeyRotateRefusal(keyState(CURRENT + 2)), "period_too_far_ahead");
  assert.equal(dmDigestKeyRotateRefusal(keyState(CURRENT, { keyCheck: CHECK })), "already_registered");
  assert.equal(dmDigestKeyRotateRefusal(keyState(CURRENT - 1, { keyCheck: CHECK, destroyed: true })), "destroyed");
});

test("a key is destroyed only after its period, with no body, no open hold and no open request left", () => {
  const ended = (overrides = {}) => keyState(CURRENT - 4, { keyCheck: CHECK, ...overrides });
  assert.equal(dmDigestKeyDestroyRefusal(ended(), 0), null);
  assert.equal(dmDigestKeyDestroyRefusal(keyState(CURRENT - 4), 0), "not_registered");
  assert.equal(dmDigestKeyDestroyRefusal(ended({ destroyed: true }), 0), "already_destroyed");
  assert.equal(dmDigestKeyDestroyRefusal(keyState(CURRENT, { keyCheck: CHECK }), 0), "period_not_ended");
  assert.equal(dmDigestKeyDestroyRefusal(ended({ bodies: 1n }), 0), "bodies_remain");
  assert.equal(dmDigestKeyDestroyRefusal(ended({ heldRequests: 1n }), 0), "hold_open");
  assert.equal(dmDigestKeyDestroyRefusal(ended(), 1), "requests_open");
  // A writer may use a key only while the registry holds the same one, undestroyed.
  assert.equal(dmDigestKeyUsable(ended(), CHECK), true);
  assert.equal(dmDigestKeyUsable(ended(), dmDigestKeyCheck(OTHER_KEY)), false);
  assert.equal(dmDigestKeyUsable(ended({ destroyed: true }), CHECK), false);
  assert.equal(dmDigestKeyUsable(keyState(CURRENT - 4), CHECK), false);
  // A destruction without its rotation cannot have been stored.
  assert.equal(dmDigestKeyPeriodStateFromRow(1, keyRow({ destroyed: true })), null);
  assert.equal(dmDigestKeyPeriodStateFromRow(1, keyRow({ keyCheck: "A".repeat(64) })), null);
});

test("audit metadata is closed keys and short tokens: never a body, digest or key check", () => {
  assert.deepEqual([...DM_BODY_AUDIT_METADATA_KEYS], ["event_id", "request_id", "kind", "key_period", "fields", "body_count"]);
  assert.deepEqual(dmBodyAuditMetadata({ request_id: REQUEST_ID, fields: ["dm_answer", "dm_rationale"], body_count: "2", kind: null }), {
    request_id: REQUEST_ID,
    fields: ["dm_answer", "dm_rationale"],
    body_count: "2",
  });
  assert.throws(() => dmBodyAuditMetadata({ text: "x" }));
  assert.throws(() => dmBodyAuditMetadata({ kind: "Use the model id." }));
  // Each key takes only its own kind of value: a digest or a key check value fits none.
  for (const fields of [
    { kind: CHECK },
    { event_id: CHECK },
    { request_id: "card-41" },
    { key_period: CHECK },
    { body_count: "6" },
    { fields: ["dm answer"] },
    { fields: [CHECK] },
    { kind: "retention_set" },
  ]) {
    assert.throws(() => dmBodyAuditMetadata(fields), JSON.stringify(fields));
  }
  assert.deepEqual(dmBodyAuditMetadata({ event_id: REQUEST_ID, kind: "destroy", key_period: "691" }), {
    event_id: REQUEST_ID,
    kind: "destroy",
    key_period: "691",
  });
});

// ---------------------------------------------------------------------------
// One writer
// ---------------------------------------------------------------------------

const walk = (directory) =>
  readdirSync(directory).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx|mjs|js|cjs)$/.test(name) ? [path] : [];
  });

const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("one module reads and writes the three tables, never updates a body, and keeps the writers apart", () => {
  const reaches =
    /\.\s*amuxDecisionMaker(Body|RetentionEvent|DigestKeyEvent)\b|\[\s*["'`]amuxDecisionMaker(Body|RetentionEvent|DigestKeyEvent)["'`]\s*\]|\b(from|into|update|join|table)\s+"?AmuxDecisionMaker(Body|RetentionEvent|DigestKeyEvent)"?\b/i;
  const files = ["app", "lib", "components", "scripts", "packages"]
    .flatMap((top) => walk(join(root, top)))
    .map((path) => relative(root, path).split("\\").join("/"));
  assert.ok(files.length > 200, "the scan must reach the application");
  const offenders = files.filter((path) => path !== STORE && reaches.test(withoutComments(readFileSync(join(root, path), "utf8"))));
  assert.deepEqual(offenders, []);
  const store = read(STORE);
  assert.match(store, /INSERT INTO "AmuxDecisionMakerBody"\n/);
  assert.match(store, /INSERT INTO "AmuxDecisionMakerRetentionEvent"\n/);
  assert.equal((store.match(/INSERT INTO "AmuxDecisionMakerDigestKeyEvent"/g) ?? []).length, 2);
  // A body is never updated, and the retention and key tables are never changed or emptied.
  assert.doesNotMatch(withoutComments(store), /UPDATE "AmuxDecisionMaker|DELETE FROM "AmuxDecisionMaker(RetentionEvent|DigestKeyEvent)|TRUNCATE/);
  assert.equal((withoutComments(store).match(/DELETE FROM "AmuxDecisionMakerBody"/g) ?? []).length, 2);
  // A person's audit through the administrator writer; the system's from its own module.
  assert.doesNotMatch(store, /systemActor|writeSystemAuditLog/);
  assert.equal((store.match(/writeAdminAuditLog\(\{/g) ?? []).length, 2);
  const audit = read(AUDIT_MODULE);
  assert.equal((audit.match(/writeSystemAuditLog\(\{/g) ?? []).length, 2);
  assert.doesNotMatch(audit, /writeAdminAuditLog/);
  // Nothing here writes a log line, and the key never reaches a statement as a value.
  for (const path of [STORE, CORE, KEYS, AUDIT_MODULE]) {
    assert.doesNotMatch(read(path), /console\./, path);
  }
  assert.doesNotMatch(store, /\$\{periodKey\}|\$\{requestKey\}/);
});

// ---------------------------------------------------------------------------
// Statements per operation (§9: 12 at most including setup and fence, pinned exactly)
// ---------------------------------------------------------------------------

const PERIOD = dmKeyPeriodOf(NOW - 10_000);
const RING = new Map([[PERIOD, KEY]]);
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

/** The S1c state read's row, as tests/amuxDecisionMakerRequest.test.mjs shapes it. */
const requestRow = (overrides = {}) => ({
  id: REQUEST_ID,
  cardId: "card-41",
  questionRevision: 3,
  askingWorkerId: "worker.claude-1",
  amuxSessionId: "session:9",
  amuxSessionAttempt: 1,
  askingProvider: "claude",
  optionSetDigest: DIGEST_A,
  termListVersion: "v1",
  classificationVersion: "authority-manifest-1",
  scannerVersion: "v1",
  policyVersion: 1,
  route: "dm_proposal",
  instance: "decision-maker-openai",
  createdAtEpochMs: BigInt(NOW - 10_000),
  assignmentDeadlineAtEpochMs: BigInt(NOW - 10_000 + DM_ASSIGNMENT_WINDOW_MS),
  dbNowEpochMs: BigInt(NOW),
  assigned: false,
  resultDeadlineAtEpochMs: null,
  transmitted: false,
  snapshotState: null,
  snapshotTargetSha: null,
  snapshotManifestDigest: null,
  inputPayloadDigest: null,
  transmitOutcome: null,
  terminalEventId: null,
  terminalResultKind: null,
  terminalResultDigest: null,
  resultUnknown: false,
  closingKind: null,
  probedRejection: null,
  ...overrides,
});
const TRANSMITTED = { assigned: true, resultDeadlineAtEpochMs: BigInt(NOW + 20 * 60_000), transmitted: true, snapshotState: "none", inputPayloadDigest: DIGEST_B };

const PERMISSIVE_SWITCHES = [
  { scope: "kill_switch", value: "off" },
  { scope: "decision-maker-openai", value: "proposal" },
  { scope: "decision-maker-anthropic", value: "proposal" },
];

const recordingTx = ({
  request = requestRow(),
  retention: retentionValues = retentionRow(),
  key = keyRow({ keyCheck: CHECK }),
  open = 0n,
  switches = PERMISSIVE_SWITCHES,
  candidates = [],
} = {}) => {
  const sent = [];
  const tx = {
    $executeRaw: (strings, ...values) => {
      sent.push({ kind: "execute", sql: strings.join("$"), values });
      return Promise.resolve(1);
    },
    $queryRaw: (strings, ...values) => {
      const sql = strings.join("$");
      sent.push({ kind: "query", sql, values });
      if (sql.includes("AT TIME ZONE 'UTC'")) return Promise.resolve([{ createdAt: new Date("2026-10-08T00:00:00.000Z") }]);
      if (sql.includes('INSERT INTO "AmuxDecisionMakerBody"')) return Promise.resolve(values[5].map((field) => ({ field })));
      if (sql.includes('INSERT INTO "AmuxDecisionMakerRequestEvent"')) {
        return Promise.resolve([{ sequence: 41n, createdAtEpochMs: BigInt(NOW + 5), resultDeadlineAtEpochMs: null }]);
      }
      if (sql.includes("INSERT INTO")) return Promise.resolve([{ sequence: 7n, createdAtEpochMs: BigInt(NOW + 5) }]);
      if (sql.includes('DELETE FROM "AmuxDecisionMakerBody"')) {
        const fields = values.length > 1 ? values[1] : retentionValues.bodyFields;
        return Promise.resolve(fields.map((field) => ({ field })));
      }
      if (sql.includes("CROSS JOIN LATERAL")) return Promise.resolve(request === null ? [] : [request]);
      if (sql.includes('"holdSets"')) return Promise.resolve([retentionValues]);
      if (sql.includes('"heldRequests"')) return Promise.resolve([key]);
      if (sql.includes('AS "open"')) return Promise.resolve([{ open }]);
      if (sql.includes("SELECT DISTINCT ON")) return Promise.resolve(switches);
      if (sql.includes('ORDER BY re."retentionUntil"')) return Promise.resolve(candidates);
      if (sql.includes('FROM "AmuxDecisionMakerBody"')) return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected statement: ${sql}`));
    },
    adminAuditLog: {
      findFirst: (query) => {
        sent.push({ kind: "findFirst", query });
        return Promise.resolve(null);
      },
      create: (query) => {
        sent.push({ kind: "create", data: query.data });
        return Promise.resolve({ id: "audit-row-1" });
      },
    },
  };
  return { tx, sent };
};

const withIntegrityKey = async (key, work) => {
  const names = ["ADMIN_AUDIT_INTEGRITY_KEY", "ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS", "NEXTAUTH_SECRET"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  if (key !== null) process.env.ADMIN_AUDIT_INTEGRITY_KEY = key;
  try {
    return await work();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
};

// The route transaction around each operation adds the boundary's setup and
// commit fence (lib/amux/dbBoundary.ts): two more statements.
const BOUNDARY_STATEMENTS = 2;
const LOCK = /pg_advisory_xact_lock\(hashtext\('tomverse-admin-audit-chain'\)\)/;
const kindsOf = (sent) => sent.map((statement) => statement.kind);
const auditOf = (sent) => sent.find((statement) => statement.kind === "create").data;
const session = { user: { id: "operator-1", email: "operator@example.test" }, expires: "2099-01-01T00:00:00.000Z" };
const leases = () => {
  const seen = [];
  return { seen, requireLeaseAt: (deadline) => seen.push(deadline.toISOString()) };
};
const resultBinding = () => ({
  cardId: "card-41",
  questionRevision: 3,
  askingWorkerId: "worker.claude-1",
  amuxSessionId: "session:9",
  amuxSessionAttempt: 1,
  optionSetDigest: DIGEST_A,
  termListVersion: "v1",
  classificationVersion: "authority-manifest-1",
  scannerVersion: "v1",
  policyVersion: 1,
  transmission: { snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null, inputPayloadDigest: DIGEST_B },
});

test("the reads are one statement each", async () => {
  {
    const { tx, sent } = recordingTx({ retention: retentionRow({ bodyFields: ["dm_rationale"], bodyBytes: 8n }) });
    const state = await readDecisionMakerBodyRetention(tx, REQUEST_ID);
    assert.deepEqual(state.bodyFields, ["dm_rationale"]);
    assert.equal(sent.length, 1);
    assert.match(sent[0].sql, /"retentionUntilEpochMs"[\s\S]*"holdSets"[\s\S]*"holdReleases"[\s\S]*"bodyFields"[\s\S]*"bodyBytes"/);
  }
  {
    const { tx, sent } = recordingTx({ key: keyRow({ keyCheck: CHECK, bodies: 3n }) });
    const state = await readDecisionMakerDigestKeyPeriod(tx, PERIOD);
    assert.equal(state.bodies, 3);
    assert.equal(sent.length, 1);
    assert.match(sent[0].sql, /HAVING count\(\*\) FILTER \(WHERE re\."kind" = 'hold_set'\) > count\(\*\) FILTER \(WHERE re\."kind" = 'hold_release'\)/);
  }
  {
    const { tx, sent } = recordingTx();
    assert.deepEqual(await readDecisionMakerBodies(tx, REQUEST_ID), []);
    assert.equal(sent.length, 1);
  }
  {
    const { tx, sent } = recordingTx({ candidates: [{ requestId: REQUEST_ID }] });
    assert.deepEqual(await listDecisionMakerPurgeCandidates(tx, { limit: 10 }), [REQUEST_ID]);
    assert.equal(sent.length, 1);
    assert.match(sent[0].sql, /"retentionUntil" <= clock_timestamp\(\)/);
    assert.deepEqual(sent[0].values, [10]);
  }
  {
    const { tx } = recordingTx({ retention: retentionRow({ bodyFields: ["dm_verdict"] }) });
    await assert.rejects(readDecisionMakerBodyRetention(tx, REQUEST_ID), (error) => error.code === "state_unreadable");
  }
});

for (const [label, integrityKey] of [
  ["without", null],
  ["with", "unit-test-integrity-key"],
]) {
  const extra = integrityKey === null ? 0 : 1;
  const auditKinds = integrityKey === null ? ["execute", "query", "create"] : ["execute", "query", "findFirst", "create"];

  test(`each write sends its pinned statements ${label} an integrity key, in order, within the budget`, async () => {
    await withIntegrityKey(integrityKey, async () => {
      const closedWithBodies = retentionRow({
        retentionUntilEpochMs: BigInt(NOW - DAY),
        bodyFields: ["dm_answer", "dm_rationale"],
        bodyBytes: 20n,
      });
      const cases = [
        {
          name: "legal hold set",
          options: {},
          run: (tx) => recordDecisionMakerLegalHold(tx, { session, requestId: REQUEST_ID, action: "set" }),
          kinds: ["execute", "query", "query", ...auditKinds, "query"],
          action: "amux.decision.legal_hold",
          actor: "operator-1",
          targetType: "AmuxDecisionMakerRetentionEvent",
          metadata: (result) => ({ event_id: result.event.eventId, request_id: REQUEST_ID, kind: "hold_set" }),
          insert: (result) => [result.event.eventId, REQUEST_ID, PERIOD, "hold_set", "operator-1", "audit-row-1"],
        },
        {
          name: "legal hold release",
          options: { retention: retentionRow({ holdSets: 1n }) },
          run: (tx) => recordDecisionMakerLegalHold(tx, { session, requestId: REQUEST_ID, action: "release" }),
          kinds: ["execute", "query", "query", ...auditKinds, "query"],
          action: "amux.decision.legal_hold",
          actor: "operator-1",
          targetType: "AmuxDecisionMakerRetentionEvent",
          metadata: (result) => ({ event_id: result.event.eventId, request_id: REQUEST_ID, kind: "hold_release" }),
          insert: (result) => [result.event.eventId, REQUEST_ID, PERIOD, "hold_release", "operator-1", "audit-row-1"],
        },
        {
          name: "expiry purge",
          options: { retention: closedWithBodies },
          run: (tx) => purgeDecisionMakerBodies(tx, { requestId: REQUEST_ID }),
          kinds: ["execute", "query", ...auditKinds, "query"],
          action: "amux.decision.body_purge",
          actor: null,
          systemActor: "amux-decision-router",
          targetType: "AmuxDecisionMakerRequest",
          targetId: REQUEST_ID,
          metadata: () => ({ request_id: REQUEST_ID, fields: ["dm_answer", "dm_rationale"], body_count: "2" }),
          insert: () => [REQUEST_ID],
        },
        {
          name: "privacy erase",
          options: { retention: retentionRow({ bodyFields: ["dm_answer", "dm_rationale"], bodyBytes: 20n }) },
          run: (tx) => eraseDecisionMakerBodies(tx, { session, requestId: REQUEST_ID, fields: ["dm_rationale", "operator_answer"] }),
          kinds: ["execute", "query", ...auditKinds, "query"],
          action: "amux.decision.body_erase",
          actor: "operator-1",
          targetType: "AmuxDecisionMakerRequest",
          targetId: REQUEST_ID,
          // Only the fields the request has.
          metadata: () => ({ request_id: REQUEST_ID, fields: ["dm_rationale"], body_count: "1" }),
          insert: () => [REQUEST_ID, ["dm_rationale"]],
        },
        {
          name: "key rotation",
          options: { key: keyRow() },
          run: (tx) => rotateDecisionMakerDigestKey(tx, { keyPeriod: PERIOD, keyRing: RING }),
          kinds: ["execute", "query", ...auditKinds, "query"],
          action: "amux.decision.digest_key_rotate",
          actor: null,
          systemActor: "amux-decision-router",
          targetType: "AmuxDecisionMakerDigestKeyEvent",
          metadata: (result) => ({ event_id: result.event.eventId, kind: "rotate", key_period: String(PERIOD) }),
          insert: (result) => [result.event.eventId, PERIOD, CHECK, "audit-row-1"],
        },
        {
          name: "key destruction",
          options: { key: keyRow({ keyCheck: CHECK }) },
          run: (tx) => destroyDecisionMakerDigestKey(tx, { keyPeriod: PERIOD - 4 }),
          kinds: ["execute", "query", "query", ...auditKinds, "query"],
          action: "amux.decision.digest_key_destroy",
          actor: null,
          systemActor: "amux-decision-router",
          targetType: "AmuxDecisionMakerDigestKeyEvent",
          metadata: (result) => ({ event_id: result.event.eventId, kind: "destroy", key_period: String(PERIOD - 4) }),
          insert: (result) => [result.event.eventId, PERIOD - 4, "audit-row-1"],
        },
      ];
      for (const entry of cases) {
        const { tx, sent } = recordingTx(entry.options);
        const result = await entry.run(tx);
        assert.ok(result.recorded === true || result.deleted === true, `${entry.name}: ${JSON.stringify(result)}`);
        assert.deepEqual(kindsOf(sent), entry.kinds, entry.name);
        assert.ok(sent.length + BOUNDARY_STATEMENTS <= 12, entry.name);
        assert.match(sent[0].sql, LOCK, entry.name);
        const audit = auditOf(sent);
        assert.equal(audit.action, entry.action, entry.name);
        assert.equal(audit.targetType, entry.targetType, entry.name);
        assert.equal(audit.targetId, entry.targetId ?? result.event.eventId, entry.name);
        assert.equal(audit.actorUserId, entry.actor, entry.name);
        const { systemActor, ...metadata } = audit.metadata;
        assert.equal(systemActor, entry.systemActor, entry.name);
        assert.deepEqual(metadata, entry.metadata(result), entry.name);
        assert.ok(Object.keys(metadata).every((key) => DM_BODY_AUDIT_METADATA_KEYS.includes(key)), entry.name);
        assert.deepEqual(sent.at(-1).values, entry.insert(result), entry.name);
      }
    });
  });

  test(`the keyed assignment and the output submission send their pinned statements ${label} an integrity key`, async () => {
    await withIntegrityKey(integrityKey, async () => {
      {
        const { tx, sent } = recordingTx();
        const lease = leases();
        const result = await assignDecisionMakerRequestWithDigestKey(tx, { requestId: REQUEST_ID, requireLeaseAt: lease.requireLeaseAt, keyRing: RING });
        assert.equal(result.recorded, true);
        assert.equal(result.keyPeriod, PERIOD);
        assert.deepEqual(result.requestKey, dmRequestDigestKey(KEY, REQUEST_ID));
        // The request, the registry, then the ledger's own assignment.
        assert.deepEqual(kindsOf(sent), ["query", "query", "execute", "query", ...auditKinds, "query"]);
        assert.equal(sent.length, 8 + extra);
        assert.ok(sent.length + BOUNDARY_STATEMENTS <= 12);
        assert.deepEqual(sent[1].values.slice(0, 1), [PERIOD]);
        assert.equal(lease.seen.length, 1);
      }
      {
        const { tx, sent } = recordingTx({ request: requestRow(TRANSMITTED) });
        const lease = leases();
        const raw = JSON.stringify({ kind: "free_text", answer: "Use the model id only.", rationale: "The locale is in the key already.", irreversible: false });
        const result = await submitDecisionMakerOutput(tx, {
          requestId: REQUEST_ID,
          instance: "decision-maker-openai",
          binding: resultBinding(),
          output: { kind: "output", raw, optionIds: ["a", "b"] },
          requireLeaseAt: lease.requireLeaseAt,
          keyRing: RING,
        });
        assert.equal(result.status, "submitted");
        assert.equal(result.result.status, "accepted");
        assert.equal(result.resultKind, "proposal");
        assert.deepEqual(result.storedFields, ["dm_answer", "dm_rationale"]);
        const requestKey = dmRequestDigestKey(KEY, REQUEST_ID);
        // The app's own digest of the submitted bytes, recorded by the ledger.
        assert.equal(result.resultDigest, dmResultDigest(requestKey, { kind: "output", raw }));
        const event = sent.find((statement) => statement.sql?.includes('INSERT INTO "AmuxDecisionMakerRequestEvent"'));
        assert.equal(event.values[10], result.resultDigest);
        // The request, the ledger's submission (lock, state, switches, audit, event), the bodies.
        assert.deepEqual(kindsOf(sent), ["query", "execute", "query", "query", ...auditKinds, "query", "query"]);
        assert.equal(sent.length, 9 + extra);
        assert.ok(sent.length + BOUNDARY_STATEMENTS <= 12);
        const bodies = sent.at(-1);
        assert.match(bodies.sql, /FROM unnest\(/);
        assert.deepEqual(bodies.values.slice(0, 4), [REQUEST_ID, PERIOD, CHECK, "audit-row-1"]);
        assert.deepEqual(bodies.values[5], ["dm_answer", "dm_rationale"]);
        assert.deepEqual(bodies.values[6], ["Use the model id only.", "The locale is in the key already."]);
        assert.deepEqual(bodies.values[7], [
          dmBodyDigest(requestKey, "dm_answer", "Use the model id only."),
          dmBodyDigest(requestKey, "dm_rationale", "The locale is in the key already."),
        ]);
      }
    });
  });
}

test("a refusal writes nothing, in the statements up to the read that refused it", async () => {
  const cases = [
    ["hold on an unknown request", { request: null }, (tx) => recordDecisionMakerLegalHold(tx, { session, requestId: REQUEST_ID, action: "set" }), { recorded: false, reason: "unknown_request" }, 2],
    ["second hold", { retention: retentionRow({ holdSets: 1n }) }, (tx) => recordDecisionMakerLegalHold(tx, { session, requestId: REQUEST_ID, action: "set" }), { recorded: false, reason: "hold_open" }, 3],
    ["release without a hold", {}, (tx) => recordDecisionMakerLegalHold(tx, { session, requestId: REQUEST_ID, action: "release" }), { recorded: false, reason: "no_open_hold" }, 3],
    ["purge of an open request", { retention: retentionRow({ bodyFields: ["dm_answer"] }) }, (tx) => purgeDecisionMakerBodies(tx, { requestId: REQUEST_ID }), { deleted: false, reason: "not_closed" }, 2],
    ["purge before the retention", { retention: retentionRow({ retentionUntilEpochMs: BigInt(NOW + 1), bodyFields: ["dm_answer"] }) }, (tx) => purgeDecisionMakerBodies(tx, { requestId: REQUEST_ID }), { deleted: false, reason: "retained" }, 2],
    ["purge under a hold", { retention: retentionRow({ retentionUntilEpochMs: BigInt(NOW), holdSets: 1n, bodyFields: ["dm_answer"] }) }, (tx) => purgeDecisionMakerBodies(tx, { requestId: REQUEST_ID }), { deleted: false, reason: "held" }, 2],
    ["erase under a hold", { retention: retentionRow({ holdSets: 1n, bodyFields: ["dm_answer"] }) }, (tx) => eraseDecisionMakerBodies(tx, { session, requestId: REQUEST_ID, fields: ["dm_answer"] }), { deleted: false, reason: "held" }, 2],
    ["erase of nothing", {}, (tx) => eraseDecisionMakerBodies(tx, { session, requestId: REQUEST_ID, fields: ["dm_answer"] }), { deleted: false, reason: "no_bodies" }, 2],
    ["rotation twice", {}, (tx) => rotateDecisionMakerDigestKey(tx, { keyPeriod: PERIOD, keyRing: RING }), { recorded: false, reason: "already_registered" }, 2],
    ["rotation of a key the ring lacks", {}, (tx) => rotateDecisionMakerDigestKey(tx, { keyPeriod: PERIOD + 1, keyRing: RING }), { recorded: false, reason: "key_not_in_ring" }, 0],
    ["destruction of the current period", { key: keyRow({ keyCheck: CHECK }) }, (tx) => destroyDecisionMakerDigestKey(tx, { keyPeriod: CURRENT }), { recorded: false, reason: "period_not_ended" }, 3],
    ["destruction with a body left", { key: keyRow({ keyCheck: CHECK, bodies: 1n }) }, (tx) => destroyDecisionMakerDigestKey(tx, { keyPeriod: PERIOD - 4 }), { recorded: false, reason: "bodies_remain" }, 3],
    ["destruction under a hold", { key: keyRow({ keyCheck: CHECK, heldRequests: 1n }) }, (tx) => destroyDecisionMakerDigestKey(tx, { keyPeriod: PERIOD - 4 }), { recorded: false, reason: "hold_open" }, 3],
    ["destruction with an open request", { key: keyRow({ keyCheck: CHECK }), open: 1n }, (tx) => destroyDecisionMakerDigestKey(tx, { keyPeriod: PERIOD - 4 }), { recorded: false, reason: "requests_open" }, 3],
    ["assignment without the period's key", {}, (tx) => assignDecisionMakerRequestWithDigestKey(tx, { requestId: REQUEST_ID, requireLeaseAt: () => assert.fail("no lease"), keyRing: new Map() }), { recorded: false, reason: "digest_key_unavailable" }, 1],
    ["assignment with another key", { key: keyRow({ keyCheck: dmDigestKeyCheck(OTHER_KEY) }) }, (tx) => assignDecisionMakerRequestWithDigestKey(tx, { requestId: REQUEST_ID, requireLeaseAt: () => assert.fail("no lease"), keyRing: RING }), { recorded: false, reason: "digest_key_unavailable" }, 2],
    ["assignment in a destroyed period", { key: keyRow({ keyCheck: CHECK, destroyed: true }) }, (tx) => assignDecisionMakerRequestWithDigestKey(tx, { requestId: REQUEST_ID, requireLeaseAt: () => assert.fail("no lease"), keyRing: RING }), { recorded: false, reason: "digest_key_unavailable" }, 2],
    ["assignment of an unknown request", { request: null }, (tx) => assignDecisionMakerRequestWithDigestKey(tx, { requestId: REQUEST_ID, requireLeaseAt: () => assert.fail("no lease"), keyRing: RING }), { recorded: false, reason: "unknown_request" }, 1],
    ["output without the period's key", {}, (tx) => submitDecisionMakerOutput(tx, { requestId: REQUEST_ID, instance: "decision-maker-openai", binding: resultBinding(), output: { kind: "timeout" }, requireLeaseAt: () => {}, keyRing: new Map() }), { status: "digest_key_unavailable" }, 1],
    ["output for an unknown request", { request: null }, (tx) => submitDecisionMakerOutput(tx, { requestId: REQUEST_ID, instance: "decision-maker-openai", binding: resultBinding(), output: { kind: "timeout" }, requireLeaseAt: () => {}, keyRing: RING }), { status: "unknown_request" }, 1],
  ];
  for (const [name, options, run, expected, statements] of cases) {
    const { tx, sent } = recordingTx(options);
    assert.deepEqual(await run(tx), expected, name);
    assert.equal(sent.length, statements, name);
    assert.ok(!sent.some((statement) => statement.kind === "create" || /INSERT|DELETE/.test(statement.sql ?? "")), name);
  }
});

test("an output's bodies follow its validation, and only an accepted result stores any", async () => {
  const submit = async (options, output) => {
    const { tx, sent } = recordingTx({ request: requestRow(TRANSMITTED), ...options });
    const result = await submitDecisionMakerOutput(tx, {
      requestId: REQUEST_ID,
      instance: "decision-maker-openai",
      binding: resultBinding(),
      output,
      requireLeaseAt: () => {},
      keyRing: RING,
    });
    return { result, sent, bodyInsert: sent.find((statement) => statement.sql?.includes('INSERT INTO "AmuxDecisionMakerBody"')) };
  };
  const out = (value) => ({ kind: "output", raw: typeof value === "string" ? value : JSON.stringify(value), optionIds: ["a", "b"] });

  // select stores its rationale; escalate its reason.
  {
    const { result, bodyInsert } = await submit({}, out({ kind: "select", optionId: "b", rationale: "Smaller key.", irreversible: false }));
    assert.equal(result.resultKind, "proposal");
    assert.deepEqual(bodyInsert.values[5], ["dm_rationale"]);
  }
  {
    const { result, bodyInsert } = await submit({}, out({ kind: "escalate", reason: "The card asks for a person." }));
    assert.equal(result.resultKind, "escalate");
    assert.deepEqual(bodyInsert.values[5], ["dm_escalation_reason"]);
  }
  // A validation failure, a timeout and an unavailable DM store nothing.
  for (const [output, kind, failure] of [
    [out("not json"), "validation_failure", "schema"],
    [out({ kind: "select", optionId: "z", rationale: "x", irreversible: false }), "validation_failure", "unknown_option"],
    [out({ kind: "free_text", answer: "Use ghp_0123456789abcdefghijklmnopqrstuvwxyzAB", rationale: "x", irreversible: false }), "validation_failure", "secret_detected"],
    // The validator passes it, but no body can hold a NUL: a schema failure, not a stored half.
    [out({ kind: "free_text", answer: "a\u0000b", rationale: "x", irreversible: false }), "validation_failure", "schema"],
    [{ kind: "timeout" }, "timeout", null],
    [{ kind: "unavailable" }, "unavailable", null],
  ]) {
    const { result, bodyInsert } = await submit({}, output);
    assert.equal(result.resultKind, kind, JSON.stringify(output));
    assert.equal(result.validationFailure, failure, JSON.stringify(output));
    assert.equal(bodyInsert, undefined, JSON.stringify(output));
    assert.deepEqual(result.storedFields, []);
  }
  // A proposal under the kill switch is recorded as a rejection, and no body is stored (section 6's table).
  {
    const { result, bodyInsert } = await submit(
      { switches: [{ scope: "kill_switch", value: "on" }, ...PERMISSIVE_SWITCHES.slice(1)] },
      out({ kind: "select", optionId: "a", rationale: "x", irreversible: false }),
    );
    assert.equal(result.result.status, "rejected");
    assert.equal(result.result.reason, "kill_switch");
    assert.equal(bodyInsert, undefined);
  }
  // The same pair again is the ledger's existing result, and stores nothing again.
  {
    const raw = JSON.stringify({ kind: "select", optionId: "a", rationale: "x", irreversible: false });
    const digest = dmResultDigest(dmRequestDigestKey(KEY, REQUEST_ID), { kind: "output", raw });
    const { result, sent, bodyInsert } = await submit(
      { request: requestRow({ ...TRANSMITTED, terminalEventId: "99999999-2222-4333-8444-555555555555", terminalResultKind: "proposal", terminalResultDigest: digest }) },
      { kind: "output", raw, optionIds: ["a", "b"] },
    );
    assert.equal(result.result.status, "existing");
    assert.equal(bodyInsert, undefined);
    assert.equal(sent.length, 3);
  }
});

test("a malformed input sends nothing at all", async () => {
  const cases = [
    (tx) => recordDecisionMakerLegalHold(tx, { session, requestId: "not-a-uuid", action: "set" }),
    (tx) => recordDecisionMakerLegalHold(tx, { session, requestId: REQUEST_ID, action: "pause" }),
    (tx) => purgeDecisionMakerBodies(tx, { requestId: null }),
    (tx) => eraseDecisionMakerBodies(tx, { session, requestId: REQUEST_ID, fields: [] }),
    (tx) => eraseDecisionMakerBodies(tx, { session, requestId: REQUEST_ID, fields: ["dm_answer", "dm_answer"] }),
    (tx) => eraseDecisionMakerBodies(tx, { session, requestId: REQUEST_ID, fields: ["dm_verdict"] }),
    (tx) => rotateDecisionMakerDigestKey(tx, { keyPeriod: -1, keyRing: RING }),
    (tx) => rotateDecisionMakerDigestKey(tx, { keyPeriod: PERIOD, keyRing: { [PERIOD]: KEY } }),
    (tx) => destroyDecisionMakerDigestKey(tx, { keyPeriod: "690" }),
    (tx) => assignDecisionMakerRequestWithDigestKey(tx, { requestId: REQUEST_ID, keyRing: RING }),
    (tx) => submitDecisionMakerOutput(tx, { requestId: REQUEST_ID, instance: "decision-maker-gemini", binding: resultBinding(), output: { kind: "timeout" }, requireLeaseAt: () => {}, keyRing: RING }),
    (tx) => submitDecisionMakerOutput(tx, { requestId: REQUEST_ID, instance: "decision-maker-openai", binding: resultBinding(), output: { kind: "timeout", raw: "x" }, requireLeaseAt: () => {}, keyRing: RING }),
    (tx) => submitDecisionMakerOutput(tx, { requestId: REQUEST_ID, instance: "decision-maker-openai", binding: resultBinding(), output: { kind: "output", raw: "{}" }, requireLeaseAt: () => {}, keyRing: RING }),
    (tx) => listDecisionMakerPurgeCandidates(tx, { limit: 101 }),
    (tx) => readDecisionMakerDigestKeyPeriod(tx, 1.5),
  ];
  for (const [index, run] of cases.entries()) {
    const { tx, sent } = recordingTx();
    await assert.rejects(run(tx), (error) => error instanceof DecisionMakerBodyWriteError && error.code === "invalid_input", String(index));
    assert.equal(sent.length, 0, String(index));
  }
  // A hold or an erase needs a person.
  for (const run of [
    (tx) => recordDecisionMakerLegalHold(tx, { session: { expires: session.expires }, requestId: REQUEST_ID, action: "set" }),
    (tx) => eraseDecisionMakerBodies(tx, { session: { expires: session.expires }, requestId: REQUEST_ID, fields: ["dm_answer"] }),
  ]) {
    const { tx, sent } = recordingTx();
    await assert.rejects(run(tx), (error) => error instanceof DecisionMakerBodyWriteError && error.code === "no_operator");
    assert.equal(sent.length, 0);
  }
});

test("the body store reads no switch: everything it does stays allowed under the kill switch", () => {
  const store = withoutComments(read(STORE));
  assert.doesNotMatch(store, /readDecisionMakerSwitches|DISTINCT ON/);
  // The two compositions reach the switches only through the ledger writes they wrap.
  assert.match(store, /await submitDecisionMakerResult\(tx,/);
  assert.match(store, /await assignDecisionMakerRequest\(tx,/);
});
