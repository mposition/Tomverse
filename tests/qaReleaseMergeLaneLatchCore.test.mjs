import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  QA_RELEASE_MERGE_LANE_LATCH_REASONS,
  qaReleaseMergeLaneLatchEventAllowed,
  qaReleaseMergeLaneLatched,
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
