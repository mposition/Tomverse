import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SNAPSHOT_RETENTION_DAYS,
  LONGEST_SNAPSHOT_RETENTION_DAYS,
  SNAPSHOT_RETENTION_DAYS,
  snapshotPurgeCutoff,
  snapshotPurgeCutoffs,
  snapshotRetentionDays,
} from "../lib/emailSnapshotRetentionCore.ts";
import { RETENTION_POLICIES, retentionPolicy } from "../lib/retentionPolicyCore.ts";
import { allTemplateDefinitions } from "../lib/emailTemplateDefinitions.ts";

// How long a delivery keeps the inputs it was rendered from.
//
// Contract: docs/policy/email-notifications.md §10.3 rule 3, §13.2.
//
// EM-08: nothing purged them. `snapshotPurgedAt` existed in the schema and no
// code wrote it, and envelope-encrypted personalisation data accumulated with
// no end -- at a rate that steps up the moment a campaign starts.

test("every classification the templates use has a window", () => {
  const used = new Set(allTemplateDefinitions().map((d) => d.classification));
  assert.ok(used.size > 0);
  for (const classification of used) {
    assert.ok(
      classification in SNAPSHOT_RETENTION_DAYS,
      `${classification} has no retention window`
    );
  }
});

test("legal outlives the rest, and by a lot", () => {
  assert.equal(SNAPSHOT_RETENTION_DAYS.transactional, 90);
  assert.equal(SNAPSHOT_RETENTION_DAYS.service, 90);
  assert.equal(SNAPSHOT_RETENTION_DAYS.marketing, 90);
  // Seven years, provisional per §21 Q6. The message is the notice itself.
  assert.equal(SNAPSHOT_RETENTION_DAYS.legal, 2555);
  assert.equal(LONGEST_SNAPSHOT_RETENTION_DAYS, 2555);
});

test("an unknown classification gets the shortest window, not the longest", () => {
  // Failing towards holding personal data for seven years by accident is the
  // worse direction.
  assert.equal(snapshotRetentionDays("something_new"), DEFAULT_SNAPSHOT_RETENTION_DAYS);
  assert.equal(DEFAULT_SNAPSHOT_RETENTION_DAYS, 90);
});

test("the cutoff is the window subtracted from now", () => {
  const now = new Date("2026-08-23T00:00:00.000Z");
  assert.equal(
    snapshotPurgeCutoff("transactional", now).toISOString(),
    "2026-05-25T00:00:00.000Z"
  );
  assert.equal(
    snapshotPurgeCutoff("legal", now).toISOString(),
    "2019-08-25T00:00:00.000Z"
  );
});

test("the sweep covers every classification exactly once", () => {
  const cutoffs = snapshotPurgeCutoffs(new Date("2026-08-23T00:00:00.000Z"));
  assert.equal(cutoffs.length, Object.keys(SNAPSHOT_RETENTION_DAYS).length);
  assert.equal(new Set(cutoffs.map((row) => row.classification)).size, cutoffs.length);
  for (const row of cutoffs) {
    assert.equal(row.days, SNAPSHOT_RETENTION_DAYS[row.classification]);
  }
});

test("the retention registry names the policy, the action and the step", () => {
  const policy = retentionPolicy("emailDeliverySnapshots");
  // `clear`, not `delete`: the row survives so the proof of notice survives
  // with it (§10.3 rule 4).
  assert.equal(policy.action, "clear");
  assert.equal(policy.maintenanceStep, "email_render_snapshots");
  assert.equal(policy.windowDays, LONGEST_SNAPSHOT_RETENTION_DAYS);
  assert.match(policy.policy, /90 days/);
  assert.match(policy.policy, /seven years/);
});

test("every non-keep policy names a step, including this one", () => {
  for (const policy of RETENTION_POLICIES) {
    if (policy.action === "keep") continue;
    assert.ok(policy.maintenanceStep, `${policy.key} performs nothing`);
  }
});
