import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  QA_RELEASE_MERGE_LANE_LATCH_REASONS,
  QA_RELEASE_MERGE_LANE_SYSTEM_RELEASABLE_REASONS,
  QA_RELEASE_MERGE_LANE_SYSTEM_RELEASE_OUTCOMES,
  qaReleaseMergeLaneLatchEventAllowed,
  qaReleaseMergeLaneLatched,
  qaReleaseMergeLaneSystemReleasable,
} from "../lib/qaReleaseMergeLaneLatchCore.ts";

test("the lane is latched only when its newest event sets it", () => {
  assert.equal(qaReleaseMergeLaneLatched(null), false);
  assert.equal(qaReleaseMergeLaneLatched({ latched: true }), true);
  assert.equal(qaReleaseMergeLaneLatched({ latched: false }), false);
});

test("setting is always allowed with a listed reason; releasing needs a latched lane", () => {
  for (const newest of [null, { latched: false }, { latched: true }]) {
    assert.equal(qaReleaseMergeLaneLatchEventAllowed(newest, { kind: "set", reason: "deploy_failed" }), true);
    assert.equal(qaReleaseMergeLaneLatchEventAllowed(newest, { kind: "set", reason: "something_else" }), false);
  }
  assert.equal(qaReleaseMergeLaneLatchEventAllowed(null, { kind: "release" }), false);
  assert.equal(qaReleaseMergeLaneLatchEventAllowed({ latched: false }, { kind: "release" }), false);
  assert.equal(qaReleaseMergeLaneLatchEventAllowed({ latched: true }, { kind: "release" }), true);
});

test("the migration's reason list is the core's", () => {
  const sql = readFileSync(
    new URL("../prisma/migrations/20261004020000_qa_release_merge_lane_latch/migration.sql", import.meta.url),
    "utf8",
  );
  const list = /"reason" IS NULL OR "reason" IN \(([^)]*)\)/.exec(sql)?.[1] ?? "";
  assert.deepEqual([...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), [...QA_RELEASE_MERGE_LANE_LATCH_REASONS]);
});

// Owner decision 2026-11-16: the lane releases a latch it read again, on develop only.
const closed = (outcome) => ({ state: "closed", outcome });
test("the lane may release only a latch whose every cause it read again and closed", () => {
  const base = { latched: true, attemptOpen: false, devHealthy: true };
  for (const reason of QA_RELEASE_MERGE_LANE_SYSTEM_RELEASABLE_REASONS) {
    assert.equal(qaReleaseMergeLaneSystemReleasable({ ...base, setsSinceRelease: [{ reason, attempt: closed("not_merged") }] }), true, reason);
  }
  for (const outcome of QA_RELEASE_MERGE_LANE_SYSTEM_RELEASE_OUTCOMES) {
    assert.equal(qaReleaseMergeLaneSystemReleasable({ ...base, setsSinceRelease: [{ reason: "deploy_failed", attempt: closed(outcome) }] }), true, outcome);
  }
  const ok = [{ reason: "merge_result_unknown", attempt: closed("deployed") }];
  assert.equal(qaReleaseMergeLaneSystemReleasable({ ...base, setsSinceRelease: ok }), true);
  // Not latched, an attempt open, dev unhealthy, or nothing set since the last release.
  assert.equal(qaReleaseMergeLaneSystemReleasable({ ...base, latched: false, setsSinceRelease: ok }), false);
  assert.equal(qaReleaseMergeLaneSystemReleasable({ ...base, attemptOpen: true, setsSinceRelease: ok }), false);
  assert.equal(qaReleaseMergeLaneSystemReleasable({ ...base, devHealthy: false, setsSinceRelease: ok }), false);
  assert.equal(qaReleaseMergeLaneSystemReleasable({ ...base, setsSinceRelease: [] }), false);
  // main, another base and the operator's control stay a person's; so does an open or person-resolved attempt.
  for (const reason of ["merged_off_develop", "merge_commit_off_develop", "revision_mismatch"]) {
    assert.equal(qaReleaseMergeLaneSystemReleasable({ ...base, setsSinceRelease: [...ok, { reason, attempt: closed("not_merged") }] }), false, reason);
  }
  for (const attempt of [null, { state: "awaiting_deploy", outcome: null }, closed("person_deployed"), closed("merged_off_develop")]) {
    assert.equal(qaReleaseMergeLaneSystemReleasable({ ...base, setsSinceRelease: [{ reason: "deploy_unknown", attempt }] }), false,
      JSON.stringify(attempt));
  }
});

test("the release migration's lists are the core's, and the reasons it may release are ones the lane sets", () => {
  const sql = readFileSync(
    new URL("../prisma/migrations/20261116150100_qa_release_merge_lane_latch_system_release/migration.sql", import.meta.url),
    "utf8",
  );
  const body = sql.slice(sql.indexOf("AS $$"));
  const reasons = /"reason" NOT IN \(([^)]*)\)/.exec(body)?.[1] ?? "";
  assert.deepEqual([...reasons.matchAll(/''([a-z_]+)''/g)].map((m) => m[1]), [...QA_RELEASE_MERGE_LANE_SYSTEM_RELEASABLE_REASONS]);
  const outcomes = /"outcome" NOT IN \(([^)]*)\)/.exec(body)?.[1] ?? "";
  assert.deepEqual([...outcomes.matchAll(/''([a-z_]+)''/g)].map((m) => m[1]), [...QA_RELEASE_MERGE_LANE_SYSTEM_RELEASE_OUTCOMES]);
  for (const reason of QA_RELEASE_MERGE_LANE_SYSTEM_RELEASABLE_REASONS) assert.ok(QA_RELEASE_MERGE_LANE_LATCH_REASONS.includes(reason));
});
