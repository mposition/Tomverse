import assert from "node:assert/strict";
import test from "node:test";

import { marketingHistorySchema } from "@/lib/marketingAutomationSchema";
import {
  marketingUtcMinusMonths,
  planMarketingHistoryCompaction,
} from "@/lib/marketingStore";

const DIGEST = "b".repeat(64);
const AT = "2026-10-16T00:00:00.000Z";
const CUTOFF = Date.parse("2026-07-01T00:00:00.000Z");

const draft = { at: "2026-01-01T00:00:00.000Z", type: "draft", envelopeDigest: DIGEST };
const attempt = (at, attemptNumber = 1, outcome = "published") => ({
  at,
  type: "attempt",
  attempt: attemptNumber,
  outcome,
  errorCode: null,
});
const webhook = (at, eventType = "post.published") => ({
  at,
  type: "webhook_event",
  eventIdDigest: DIGEST,
  eventType,
});

const plan = (history, overrides = {}) =>
  planMarketingHistoryCompaction({
    history,
    status: "published",
    publishAttempt: 1,
    cutoffMs: CUTOFF,
    at: AT,
    ...overrides,
  });

test("months are subtracted the way PostgreSQL subtracts them, clamping the day", () => {
  const cases = [
    ["2028-02-29T10:20:30.456Z", 24, "2026-02-28T10:20:30.456Z"],
    ["2026-03-31T00:00:00.000Z", 1, "2026-02-28T00:00:00.000Z"],
    ["2028-03-31T23:59:59.999Z", 1, "2028-02-29T23:59:59.999Z"],
    ["2026-10-16T05:00:00.000Z", 24, "2024-10-16T05:00:00.000Z"],
    ["2026-01-15T00:00:00.000Z", 13, "2024-12-15T00:00:00.000Z"],
  ];
  for (const [from, months, expected] of cases) {
    assert.equal(marketingUtcMinusMonths(new Date(from), months).toISOString(), expected, from);
  }
});

test("nothing old enough to go is no plan at all", () => {
  assert.equal(plan([draft, attempt("2026-08-01T00:00:00.000Z")]), null);
  assert.equal(plan([draft]), null);
});

test("old attempts and webhook ids are replaced by one summary each and one closing entry", () => {
  const history = [
    draft,
    attempt("2026-03-02T00:00:00.000Z"),
    webhook("2026-03-03T00:00:00.000Z"),
    webhook("2026-03-01T00:00:00.000Z", "post.verified"),
    attempt("2026-08-01T00:00:00.000Z", 2),
  ];
  const result = plan(history, { publishAttempt: 2 });
  assert.equal(result.removedEntryCount, 3);
  assert.deepEqual(result.history, [
    draft,
    attempt("2026-08-01T00:00:00.000Z", 2),
    {
      at: AT,
      type: "retention_summary",
      summarises: "attempt",
      count: 1,
      firstAt: "2026-03-02T00:00:00.000Z",
      lastAt: "2026-03-02T00:00:00.000Z",
    },
    {
      at: AT,
      type: "retention_summary",
      summarises: "webhook_event",
      count: 2,
      firstAt: "2026-03-01T00:00:00.000Z",
      lastAt: "2026-03-03T00:00:00.000Z",
    },
    { at: AT, type: "retention_compaction", removedEntryCount: 3 },
  ]);
  // What the store writes is what the store can read back.
  assert.equal(marketingHistorySchema.safeParse(result.history).success, true);
});

test("a failed post keeps the failure its re-queue is measured against, whatever its age", () => {
  const failure = attempt("2026-03-01T00:00:00.000Z", 2, "failed");
  const earlier = attempt("2026-02-01T00:00:00.000Z", 1, "failed");
  const result = plan([draft, earlier, failure], { status: "failed", publishAttempt: 2 });
  assert.equal(result.removedEntryCount, 1);
  assert.deepEqual(result.history.slice(0, 2), [draft, failure]);

  assert.equal(plan([draft, failure], { status: "failed", publishAttempt: 2 }), null);
  // Once it is no longer failed, the same entry is ordinary history.
  assert.equal(plan([draft, failure], { status: "scheduled", publishAttempt: 2 }).removedEntryCount, 1);
});

test("entries no type rule allows to go stay at any age, earlier summaries included", () => {
  const earlierSummary = {
    at: "2026-02-01T00:00:00.000Z",
    type: "retention_summary",
    summarises: "attempt",
    count: 4,
    firstAt: "2025-10-01T00:00:00.000Z",
    lastAt: "2025-10-04T00:00:00.000Z",
  };
  const earlierClose = { at: "2026-02-01T00:00:00.000Z", type: "retention_compaction", removedEntryCount: 4 };
  const guard = {
    at: "2026-01-01T00:00:00.000Z",
    type: "guard_result",
    decision: "approval_required",
    codes: [],
    ruleIds: [],
  };
  const result = plan([draft, guard, earlierSummary, earlierClose, webhook("2026-03-01T00:00:00.000Z")]);
  assert.deepEqual(result.history.slice(0, 4), [draft, guard, earlierSummary, earlierClose]);
  assert.equal(result.history.at(-1).type, "retention_compaction");
  assert.equal(result.history.at(-1).removedEntryCount, 1);
});

test("an entry inside the cutoff millisecond is old only if every digit says so", () => {
  const exact = new Date(CUTOFF).toISOString();
  assert.equal(plan([draft, webhook(exact)]).removedEntryCount, 1);
  // Microseconds past the cutoff: a JS Date reads this as the cutoff itself,
  // PostgreSQL does not.
  assert.equal(plan([draft, webhook(exact.replace(".000Z", ".000001Z"))]), null);
});

test("first and last are chosen to the microsecond, not to the millisecond", () => {
  const later = "2026-03-01T00:00:00.000900Z";
  const earlier = "2026-03-01T00:00:00.000100Z";
  const result = plan([draft, webhook(later), webhook(earlier, "post.verified")]);
  const summary = result.history.find((entry) => entry.type === "retention_summary");
  assert.equal(summary.firstAt, earlier);
  assert.equal(summary.lastAt, later);
});

test("identical entries are both removed or both kept, as the trigger counts them", () => {
  const twin = webhook("2026-03-01T00:00:00.000Z");
  const result = plan([draft, twin, { ...twin }]);
  assert.equal(result.removedEntryCount, 2);
  assert.deepEqual(result.history.slice(0, 1), [draft]);
});

test("a history at the ceiling that would grow is left for later", () => {
  const filler = Array.from({ length: 499 }, (_, index) => ({
    at: `2026-08-01T00:00:${String(index % 60).padStart(2, "0")}.${String(index).padStart(3, "0")}Z`,
    type: "guard_result",
    decision: "approval_required",
    codes: [],
    ruleIds: [],
  }));
  assert.equal(plan([...filler, webhook("2026-03-01T00:00:00.000Z")]), null);
});
