import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDIENCE_EXCLUSIONS,
  audienceExclusion,
  stillAffected,
  summariseAudience,
} from "../lib/modelRetirementAudienceCore.ts";

const member = (overrides = {}) => ({
  userId: "u1",
  cohorts: ["default_model"],
  hasEmail: true,
  accountActive: true,
  suppressed: false,
  planAllowsReplacement: true,
  malformed: false,
  ...overrides,
});

const rows = { default_model: 0, new_conversation_lead: 0, conversation_selection: 0 };

test("overlapping cohorts count one person once", () => {
  // The worked example: 10,963 rows, 3,012 users. A notice sized from rows
  // would have been three times too confident about its reach.
  const summary = summariseAudience(
    [
      member({
        userId: "u1",
        cohorts: ["default_model", "new_conversation_lead", "conversation_selection"],
      }),
      member({ userId: "u2", cohorts: ["conversation_selection"] }),
    ],
    rows
  );
  assert.equal(summary.distinctUsers, 2);
  assert.equal(summary.cohortUsers.default_model, 1);
  assert.equal(summary.cohortUsers.conversation_selection, 2);
  assert.equal(summary.noticeAudience, 2);
});

test("the same user arriving twice does not double anything", () => {
  const summary = summariseAudience([member(), member()], rows);
  assert.equal(summary.distinctUsers, 1);
  assert.equal(summary.noticeAudience, 1);
});

test("exclusions are ordered and each person counts against exactly one", () => {
  // no_email first: without an address there is nothing to check a suppression
  // list against, so reporting "suppressed" would be a guess.
  assert.equal(
    audienceExclusion(member({ hasEmail: false, suppressed: true, accountActive: false })),
    "no_email"
  );
  assert.equal(audienceExclusion(member({ accountActive: false, suppressed: true })), "account_inactive");
  assert.equal(audienceExclusion(member({ suppressed: true })), "suppressed");
  assert.equal(audienceExclusion(member({ planAllowsReplacement: false })), "plan_incompatible");
  assert.equal(audienceExclusion(member()), null);
});

test("the excluded and the audience add up to the population", () => {
  const members = [
    member({ userId: "a" }),
    member({ userId: "b", hasEmail: false }),
    member({ userId: "c", suppressed: true }),
    member({ userId: "d", accountActive: false }),
    member({ userId: "e", planAllowsReplacement: false }),
  ];
  const summary = summariseAudience(members, rows);
  const excludedTotal = AUDIENCE_EXCLUSIONS.reduce(
    (total, reason) => total + summary.excluded[reason],
    0
  );
  assert.equal(summary.noticeAudience + excludedTotal, summary.distinctUsers);
});

test("a malformed value is told about the retirement but never promised a change", () => {
  // The parser preserves what it cannot read, so an automatic change is not
  // something we can truthfully offer that account.
  const summary = summariseAudience([member({ malformed: true })], rows);
  assert.equal(summary.noticeAudience, 1);
  assert.equal(summary.autoMigratable, 0);
  assert.equal(summary.malformed, 1);
});

test("auto-migratable never exceeds the notice audience", () => {
  const summary = summariseAudience(
    [
      member({ userId: "a" }),
      member({ userId: "b", malformed: true }),
      member({ userId: "c", suppressed: true }),
    ],
    rows
  );
  assert.ok(summary.autoMigratable <= summary.noticeAudience);
  assert.equal(summary.autoMigratable, 1);
  assert.equal(summary.noticeAudience, 2);
});

test("somebody who already changed their model drops out of the reminder", () => {
  assert.equal(stillAffected({ cohorts: [] }), false);
  assert.equal(stillAffected({ cohorts: ["default_model"] }), true);
});

test("an empty population is not an error", () => {
  const summary = summariseAudience([], rows);
  assert.equal(summary.distinctUsers, 0);
  assert.equal(summary.noticeAudience, 0);
});
