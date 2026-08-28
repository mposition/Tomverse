import assert from "node:assert/strict";
import test from "node:test";

import {
  ATTACHMENT_AUDIT_STATES,
  auditRow,
  classifyAttachmentProbe,
  decodeAuditCursor,
  describeAuditSummary,
  emptyAuditSummary,
  encodeAuditCursor,
  mapWithConcurrency,
  probeWithRetry,
} from "../scripts/audit-message-attachment-objects-core.mjs";

const row = (overrides = {}) => ({
  id: "att_9",
  conversationId: "cmtaqxy0g000202mncs315nym",
  userId: "user_1",
  objectKey: "attachments/9f2caa0b/nda-signed.jpg",
  mediaType: "image/jpeg",
  size: 40_000,
  createdAt: new Date("2026-08-26T09:00:00.000Z"),
  unavailableAt: null,
  ...overrides,
});

const probe = (overrides = {}) => ({
  state: "present",
  size: 40_000,
  contentType: "image/jpeg",
  lastModified: null,
  storageStatus: 200,
  ...overrides,
});

test("the audit has four states, not two", () => {
  assert.deepEqual([...ATTACHMENT_AUDIT_STATES], [
    "available",
    "missing",
    "temporarily_unreachable",
    "metadata_mismatch",
  ]);
});

test("a present, matching object is available", () => {
  assert.equal(classifyAttachmentProbe(probe(), row()), "available");
});

test("a 404 is missing", () => {
  assert.equal(
    classifyAttachmentProbe(probe({ state: "missing", storageStatus: 404 }), row()),
    "missing"
  );
});

/*
  The distinction the whole tool turns on.

  A run during a credentials rotation or a bucket incident must not report that
  an account lost every file it owns. `--apply` only ever writes rows in the
  `missing` state, so this classification is what stands between a five-minute
  outage and a permanent, wrong record.
*/
test("an unreachable probe is never reported as loss", () => {
  assert.equal(
    classifyAttachmentProbe(probe({ state: "unreachable", storageStatus: 403 }), row()),
    "temporarily_unreachable"
  );
  assert.equal(
    classifyAttachmentProbe(probe({ state: "unreachable", storageStatus: null }), row()),
    "temporarily_unreachable"
  );
});

test("a size or type disagreement is its own state", () => {
  assert.equal(classifyAttachmentProbe(probe({ size: 12 }), row()), "metadata_mismatch");
  assert.equal(
    classifyAttachmentProbe(probe({ contentType: "application/pdf" }), row()),
    "metadata_mismatch"
  );
});

test("a content type with parameters still matches", () => {
  assert.equal(
    classifyAttachmentProbe(probe({ contentType: "image/jpeg; charset=binary" }), row()),
    "available"
  );
});

/*
  A report about missing files must not itself be a leak.

  This artefact is produced routinely and pasted into tickets, so the row shape
  is an allowlist rather than a redaction pass -- there is no option to widen
  it, and a spread of the database row would carry `objectKey`.
*/
test("an audit row carries no key, no filename and no user", () => {
  const entry = auditRow(row(), "missing", probe({ state: "missing", storageStatus: 404 }));
  assert.deepEqual(Object.keys(entry).sort(), [
    "alreadyMarkedUnavailable",
    "attachmentId",
    "conversationId",
    "createdAt",
    "declaredSize",
    "mediaType",
    "state",
    "storageStatus",
  ]);
  const serialised = JSON.stringify(entry);
  assert.ok(!serialised.includes("attachments/"));
  assert.ok(!serialised.includes("nda-signed"));
  assert.ok(!serialised.includes("user_1"));
});

test("the cursor is keyset, so insertions cannot make it skip or repeat", () => {
  const cursor = encodeAuditCursor(row());
  assert.equal(cursor, "2026-08-26T09:00:00.000Z|att_9");
  const decoded = decodeAuditCursor(cursor);
  assert.equal(decoded.id, "att_9");
  assert.equal(decoded.createdAt.toISOString(), "2026-08-26T09:00:00.000Z");
  assert.equal(decodeAuditCursor("nonsense"), null);
  assert.equal(decodeAuditCursor(undefined), null);
});

test("concurrency is bounded, and the results stay in order", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, index) => index);
  const results = await mapWithConcurrency(items, 3, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return item * 2;
  });
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
  assert.deepEqual(results, items.map((item) => item * 2));
});

test("only an unreachable probe is retried; a 404 is not", async () => {
  let calls = 0;
  const result = await probeWithRetry(
    async () => {
      calls += 1;
      return { state: "missing", size: null, contentType: null, storageStatus: 404 };
    },
    { attempts: 3, sleep: async () => {} }
  );
  assert.equal(calls, 1);
  assert.equal(result.state, "missing");
});

test("an unreachable probe backs off and can still succeed", async () => {
  let calls = 0;
  const waits = [];
  const result = await probeWithRetry(
    async () => {
      calls += 1;
      return calls < 3
        ? { state: "unreachable", size: null, contentType: null, storageStatus: 503 }
        : { state: "present", size: 1, contentType: "image/jpeg", storageStatus: 200 };
    },
    { attempts: 3, baseDelayMs: 10, sleep: async (ms) => waits.push(ms) }
  );
  assert.equal(calls, 3);
  assert.equal(result.state, "present");
  assert.deepEqual(waits, [10, 20]);
});

/*
  A partial run that reports only what it found reads as a complete one.

  "12 files are missing" and "12 files are missing out of the 400 we reached,
  of 51,000" are different findings, and only the second is safe to act on.
*/
test("the summary states what it did not examine", () => {
  const summary = { ...emptyAuditSummary(), totalRows: 51_000, examined: 400, missing: 12 };
  const lines = describeAuditSummary(summary).join("\n");
  assert.ok(lines.includes("Rows in scope:        51000"));
  assert.ok(lines.includes("Rows examined:        400"));
  assert.ok(lines.includes("Not examined:         50600"));
});

test("an unknown total is reported as unknown rather than as zero", () => {
  const lines = describeAuditSummary(emptyAuditSummary()).join("\n");
  assert.ok(lines.includes("Rows in scope:        unknown"));
  assert.ok(lines.includes("Not examined:         unknown"));
});
