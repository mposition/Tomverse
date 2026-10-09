import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  QA_RELEASE_MERGE_ATTEMPT_OBSERVATION_STATE,
  QA_RELEASE_MERGE_ATTEMPT_OPEN_STATES,
  QA_RELEASE_MERGE_ATTEMPT_OUTCOMES,
  QA_RELEASE_MERGE_ATTEMPT_PERSON_OUTCOMES,
  QA_RELEASE_MERGE_ATTEMPT_STATES,
  QA_RELEASE_MERGE_ATTEMPT_TRANSITIONS,
  qaReleaseMergeAttemptTransitionAllowed,
} from "../lib/qaReleaseMergeAttemptCore.ts";

const MIGRATION = readFileSync(
  new URL("../prisma/migrations/20261004010000_qa_release_merge_attempt/migration.sql", import.meta.url),
  "utf8",
);

test("closed is terminal and every open state can reach it", () => {
  assert.equal(QA_RELEASE_MERGE_ATTEMPT_TRANSITIONS.some((t) => t.from === "closed"), false);
  for (const state of QA_RELEASE_MERGE_ATTEMPT_OPEN_STATES) {
    assert.ok(QA_RELEASE_MERGE_ATTEMPT_TRANSITIONS.some((t) => t.from === state && t.to === "closed"), state);
  }
  assert.deepEqual([...QA_RELEASE_MERGE_ATTEMPT_OPEN_STATES, "closed"], [...QA_RELEASE_MERGE_ATTEMPT_STATES]);
});

test("a deployment outcome closes only an attempt awaiting deploy, and a merge outcome only one before it", () => {
  assert.equal(qaReleaseMergeAttemptTransitionAllowed("awaiting_deploy", "closed", "deployed"), true);
  assert.equal(qaReleaseMergeAttemptTransitionAllowed("consumed", "closed", "deployed"), false);
  assert.equal(qaReleaseMergeAttemptTransitionAllowed("awaiting_deploy", "closed", "merge_refused"), false);
  assert.equal(qaReleaseMergeAttemptTransitionAllowed("issued", "closed", "merge_refused"), false);
  assert.equal(qaReleaseMergeAttemptTransitionAllowed("consumed", "closed", "merge_refused"), true);
  // Never back, never in place, and an open move carries no outcome.
  assert.equal(qaReleaseMergeAttemptTransitionAllowed("consumed", "issued", null), false);
  assert.equal(qaReleaseMergeAttemptTransitionAllowed("issued", "issued", null), false);
  assert.equal(qaReleaseMergeAttemptTransitionAllowed("issued", "consumed", "deployed"), false);
  assert.equal(qaReleaseMergeAttemptTransitionAllowed("awaiting_deploy", "closed", null), false);
});

test("every outcome is reachable, and the person outcomes are exactly those named person_", () => {
  const reachable = new Set(QA_RELEASE_MERGE_ATTEMPT_TRANSITIONS.flatMap((t) => t.outcomes ?? []));
  assert.deepEqual([...reachable].sort(), [...QA_RELEASE_MERGE_ATTEMPT_OUTCOMES].sort());
  assert.deepEqual(
    [...QA_RELEASE_MERGE_ATTEMPT_PERSON_OUTCOMES],
    QA_RELEASE_MERGE_ATTEMPT_OUTCOMES.filter((outcome) => outcome.startsWith("person_")),
  );
});

test("the migration's trigger states the core's transition table, row for row", () => {
  const rows = [...MIGRATION.matchAll(/WHEN OLD\."state" = '([a-z_]+)' AND NEW\."state" = '([a-z_]+)'\s*(?:THEN NEW\."outcome" IS NULL|THEN NEW\."outcome" IN \(([^)]*)\))/g)].map(
    (m) => ({ from: m[1], to: m[2], outcomes: m[3] ? [...m[3].matchAll(/'([a-z_]+)'/g)].map((o) => o[1]) : undefined }),
  );
  assert.deepEqual(
    rows,
    QA_RELEASE_MERGE_ATTEMPT_TRANSITIONS.map((t) => ({ from: t.from, to: t.to, outcomes: t.outcomes ? [...t.outcomes] : undefined })),
  );
  const personList = /by_person := NEW\."outcome" IN \(([^)]*)\)/.exec(MIGRATION)?.[1] ?? "";
  assert.deepEqual([...personList.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), [...QA_RELEASE_MERGE_ATTEMPT_PERSON_OUTCOMES]);
  // The one same-state change: the lane's observation while awaiting deploy.
  assert.match(
    MIGRATION,
    new RegExp(`IF NOT allowed AND OLD\\."state" = '${QA_RELEASE_MERGE_ATTEMPT_OBSERVATION_STATE}' AND NEW\\."state" = '${QA_RELEASE_MERGE_ATTEMPT_OBSERVATION_STATE}' THEN`),
  );
  // The lane may write the same list again, and that write moves the observation time.
  assert.match(MIGRATION, /allowed := NEW\."outcome" IS NULL AND NEW\."deployObservation" IS NOT NULL\s+AND NEW\."mergeCommitSha" IS NOT DISTINCT FROM OLD\."mergeCommitSha";/);
  assert.match(MIGRATION, /WHEN NEW\."deployObservation" IS DISTINCT FROM OLD\."deployObservation" OR observation_only THEN now_/);
  const openStates = /one_open_per_base_key"\s*ON "QaReleaseMergeAttempt" \("base"\)\s*WHERE "state" IN \(([^)]*)\)/.exec(MIGRATION)?.[1] ?? "";
  assert.deepEqual([...openStates.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), [...QA_RELEASE_MERGE_ATTEMPT_OPEN_STATES]);
});
