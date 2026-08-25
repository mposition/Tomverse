import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUDIENCE_DEFINITION_VERSION,
  summariseAudience,
} from "../lib/modelRetirementAudienceCore.ts";

// A bounded count has to say it was bounded (EM-01 slice 8).
//
// Contract: .github/audits/model-lifecycle-email-2026-08-22.md §11.
//
// The scan behind an estimate walks every account naming the retiring model, so
// on the audience an operator most wants sized it is also most expensive. It is
// bounded because somebody is waiting -- and the moment it is bounded, the only
// dangerous thing it can do is report a floor as a total.

/** An `AudienceMember` nothing excludes, so a test can vary one thing at a time. */
const member = (over = {}) => ({
  userId: "u1",
  cohorts: ["default_model"],
  hasEmail: true,
  accountActive: true,
  suppressed: false,
  planAllowsReplacement: true,
  malformed: false,
  ...over,
});

const noCohortRows = {
  default_model: 0,
  new_conversation_lead: 0,
  conversation_selection: 0,
};

test("a complete scan reports truncated false, not undefined", () => {
  const summary = summariseAudience([member()], noCohortRows);
  // Explicitly false rather than absent: a screen testing `summary.truncated`
  // would read `undefined` as falsy and be right by accident, and a serialised
  // summary that omits the key cannot be told from one written before the flag
  // existed.
  assert.equal(summary.truncated, false);
  assert.ok("truncated" in summary);
});

test("a truncated scan carries the flag through to the summary", () => {
  const summary = summariseAudience([member()], noCohortRows, true);
  assert.equal(summary.truncated, true);
});

test("truncation does not change any of the figures it bounds", () => {
  const members = [
    member({ userId: "u1" }),
    member({ userId: "u2", cohorts: ["conversation_selection"] }),
  ];
  const full = summariseAudience(members, noCohortRows, false);
  const capped = summariseAudience(members, noCohortRows, true);

  // Stated before the comparison: two summaries of an empty audience are equal
  // for a reason that has nothing to do with truncation, so without this the
  // assertions below would hold even if the fixture stopped counting anybody.
  assert.equal(full.noticeAudience, 2);

  // The flag says the scan stopped early; it does not adjust, extrapolate or
  // round anything. Every number is still exactly what was counted, which is
  // what makes "at least N" a true sentence rather than a guess at N.
  assert.equal(capped.noticeAudience, full.noticeAudience);
  assert.equal(capped.distinctUsers, full.distinctUsers);
  assert.deepEqual(capped.excluded, full.excluded);
  assert.deepEqual(capped.cohortUsers, full.cohortUsers);
});

test("the rules version is a number a stored estimate can be stamped with", () => {
  // `EmailCampaign.audienceVersion` has a CHECK requiring >= 1, and claimed
  // since the fourth slice to say which rules produced an estimate while
  // nothing wrote it. A version below 1 could not be stored at all.
  assert.ok(Number.isInteger(AUDIENCE_DEFINITION_VERSION));
  assert.ok(AUDIENCE_DEFINITION_VERSION >= 1);
});

test("malformed people are counted but never auto-migratable", () => {
  const summary = summariseAudience(
    [member({ userId: "u1", malformed: true }), member({ userId: "u2" })],
    noCohortRows
  );
  // The estimate's headline includes them -- they still get the notice -- and
  // the automatic-change figure does not, because a value the parser could not
  // read is preserved rather than rewritten.
  assert.equal(summary.noticeAudience, 2);
  assert.equal(summary.autoMigratable, 1);
  assert.equal(summary.malformed, 1);
});
