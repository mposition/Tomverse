import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import { NON_WRITE_CACHE_MODES } from "../scripts/ci-cache-key-policy.mjs";

/**
 * The lane that runs the unit tests on a push to develop.
 *
 * Operator decision, 2026-10-08. It exists because content reaches develop by
 * push as well as by pull request, and a push had no unit tests: an automated
 * back-merge duplicated an `office` entry in the admin navigation, the suite
 * that refuses duplicate ids never ran, and the production build failed
 * type-check at the deployed environment with the deploy reported only as
 * SKIPPED.
 *
 * These assertions exist because a review asked the right question of the first
 * version: **nothing held the trigger.** The cache-key policy pins how many
 * workflows reach a widely readable scope, which stays green if a
 * `workflow_dispatch` is added back, and the workflow's own comment contains
 * that word, so a text search for it finds the explanation rather than the
 * trigger. A comment cannot refuse an edit; this can.
 */

const WORKFLOW = ".github/workflows/develop-push-unit-tests.yml";

const workflow = () => parseYaml(readFileSync(WORKFLOW, "utf8"));

test("the lane runs on a push to develop and on nothing else", () => {
  const document = workflow();
  // Read the trigger, never the prose: the file explains why there is no
  // dispatch, so the word appears in it.
  assert.deepEqual(Object.keys(document.on), ["push"]);
  assert.deepEqual(document.on.push.branches, ["develop"]);
  // A path filter would let a push that touches nothing listed skip the suite,
  // and the back-merge that prompted this lane touched two library files and a
  // lockfile -- a filter written for one shape of change is the hole again.
  assert.equal(document.on.push.paths, undefined);
  assert.equal(document.on.push["paths-ignore"], undefined);
});

test("a trigger added later cannot cancel the push run", () => {
  // A ref-only concurrency group lets any second trigger cancel the push run,
  // and Railway reads a cancelled suite as a failure and skips that commit's
  // deploy. orchestrator-rust.yml and secret-history-scan.yml answer this by
  // putting the event name in the key; so does this.
  const { concurrency } = workflow();
  assert.ok(concurrency, "the lane must declare a concurrency group");
  assert.match(concurrency.group, /github\.event_name/);
  assert.match(concurrency.group, /github\.ref/);
  assert.equal(concurrency["cancel-in-progress"], true);
});

test("the lane's cache token cannot write", () => {
  // A push is a trusted trigger and a trusted trigger defaults to `write`.
  const document = workflow();
  assert.ok(
    NON_WRITE_CACHE_MODES.includes(document["cache-mode"]),
    `cache-mode must be one of ${NON_WRITE_CACHE_MODES.join(", ")}, found ${document["cache-mode"]}`,
  );
});

test("the lane runs the whole unit suite, not a chosen part of it", () => {
  // The point is coverage of what a push can carry, so the step runs the same
  // command PR Fast Gate runs. A narrowed invocation would pass this lane while
  // leaving the next duplicate to the deploy.
  const document = workflow();
  const jobs = Object.values(document.jobs);
  assert.equal(jobs.length, 1, "one job: this lane is the unit tests and nothing else");
  const [job] = jobs;
  const commands = job.steps.map((step) => step.run).filter(Boolean);
  assert.ok(
    commands.includes("npm run test:unit"),
    `expected the lane to run "npm run test:unit", found ${JSON.stringify(commands)}`,
  );
  assert.equal(job.permissions, undefined, "the workflow-level read permission covers it");
  assert.equal(document.permissions.contents, "read");
});

test("the suite this lane runs is the one that refuses the duplicate", () => {
  // The closing of the loop: tests/adminNavigation.test.mjs is what would have
  // stopped the back-merge, `npm run test:unit` discovers tests/*.test.mjs, and
  // this file is discovered the same way -- so the lane also runs its own
  // assertions.
  const runner = readFileSync("scripts/run-unit-tests.mjs", "utf8");
  assert.match(runner, /\.test\.mjs/);
  const navigationTest = readFileSync("tests/adminNavigation.test.mjs", "utf8");
  assert.match(navigationTest, /duplicate navigation id/);
  assert.match(navigationTest, /duplicate navigation href/);
});
