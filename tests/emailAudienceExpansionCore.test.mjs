import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPANSION_BATCH_SIZE,
  expansionRefusal,
  nextBatchPlan,
  readExpansionSpec,
} from "../lib/emailAudienceExpansionCore.ts";

// The decisions a fan-out makes (EM-01).
//
// Contract: docs/policy/email-notifications.md §10.2,
// .github/audits/model-lifecycle-email-2026-08-22.md EM-01, §12.3.

test("a single-user event is never expanded", () => {
  // The enqueue path writes that event whole, delivery row and all. Expanding
  // one would mean a second row for the same person.
  assert.equal(
    expansionRefusal({ audienceKind: "single_user", status: "pending" }),
    "not_a_segment"
  );
});

test("a finished fan-out is not run again", () => {
  assert.equal(
    expansionRefusal({ audienceKind: "user_segment", status: "expanded" }),
    "already_expanded"
  );
});

test("a half-finished fan-out resumes", () => {
  // `expanding` is what a pass that died leaves behind. Refusing it would make
  // a crash permanent, and resuming is safe because the unique index decides
  // duplicates rather than this function.
  assert.equal(
    expansionRefusal({ audienceKind: "user_segment", status: "expanding" }),
    null
  );
  assert.equal(
    expansionRefusal({ audienceKind: "all_users", status: "pending" }),
    null
  );
});

test("a failed fan-out waits for a person", () => {
  // It left an unknown amount done, and what made it fail is usually not the
  // kind of thing that fixes itself.
  assert.equal(
    expansionRefusal({ audienceKind: "user_segment", status: "failed" }),
    "previously_failed"
  );
});

test("an unreadable spec reaches nobody rather than throwing", () => {
  // An expansion that cannot tell who it is for must reach nobody. Throwing
  // would mark the event failed for what may be one mistyped field.
  for (const raw of [null, undefined, "", 42, [], "not json"]) {
    assert.deepEqual(readExpansionSpec(raw), {});
  }
});

test("the spec keeps only what it can use", () => {
  assert.deepEqual(
    readExpansionSpec({
      userIds: ["a", 7, "b", null],
      recipientCap: 50,
      dryRun: true,
      somethingElse: "ignored",
    }),
    { userIds: ["a", "b"], recipientCap: 50, dryRun: true }
  );
});

test("a nonsense cap is no cap, not a cap of zero", () => {
  // A cap of zero reaches nobody, so reading "-1" or "many" as zero would turn
  // a typo into a silent no-op send.
  for (const recipientCap of [-1, 1.5, "50", null, Number.NaN]) {
    assert.equal(readExpansionSpec({ recipientCap }).recipientCap, undefined);
  }
  // Zero itself is honoured: somebody wrote it.
  assert.equal(readExpansionSpec({ recipientCap: 0 }).recipientCap, 0);
});

test("dryRun is only true when it says true", () => {
  assert.equal(readExpansionSpec({ dryRun: "yes" }).dryRun, undefined);
  assert.equal(readExpansionSpec({ dryRun: 1 }).dryRun, undefined);
  assert.equal(readExpansionSpec({ dryRun: true }).dryRun, true);
});

test("with no cap, every batch is a full batch", () => {
  assert.deepEqual(nextBatchPlan({ expandedSoFar: 10_000 }), {
    take: EXPANSION_BATCH_SIZE,
    capReached: false,
  });
});

test("the last batch under a cap is the size of what is left", () => {
  assert.deepEqual(
    nextBatchPlan({ expandedSoFar: 90, recipientCap: 100, batchSize: 40 }),
    { take: 10, capReached: false }
  );
});

test("a reached cap is reported, not inferred from an empty batch", () => {
  // "The cap stopped this" and "nobody was left" are different outcomes, and a
  // caller that had to tell them apart from a zero would get it wrong.
  assert.deepEqual(nextBatchPlan({ expandedSoFar: 100, recipientCap: 100 }), {
    take: 0,
    capReached: true,
  });
  assert.deepEqual(nextBatchPlan({ expandedSoFar: 120, recipientCap: 100 }), {
    take: 0,
    capReached: true,
  });
});

test("a cap of zero stops before the first batch", () => {
  assert.deepEqual(nextBatchPlan({ expandedSoFar: 0, recipientCap: 0 }), {
    take: 0,
    capReached: true,
  });
});

test("a resumed pass spends the cap the earlier one already spent", () => {
  // The count comes from the table rather than from this pass, so a fan-out
  // resumed three times does not get three caps.
  assert.deepEqual(
    nextBatchPlan({ expandedSoFar: 75, recipientCap: 100, batchSize: 200 }),
    { take: 25, capReached: false }
  );
});
