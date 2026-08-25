import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { parse } from "yaml";

/**
 * The back-merge workflow must never fail its own run.
 *
 * Railway's production service deploys `main` with Wait for CI, and Railway's
 * rule is all-or-nothing: any failing workflow on the commit turns the pending
 * deployment into SKIPPED, and Railway offers no way to say which workflows are
 * the release verdict. So for as long as this workflow could fail, a conflict
 * between `main` and `develop` -- which says nothing about whether `main` is
 * deployable -- cancelled the production deployment of whichever release was
 * waiting. On 2026-08-25 that skipped #953, #954, #960, #968 and #969, each one
 * 1-2 seconds after this workflow reported failure.
 *
 * The alarm moved to a tracking issue, which is why `issues: write` is asserted
 * here too: without it the guard cannot report at all, and a workflow that is
 * both green and mute is strictly worse than the red X it replaced.
 *
 * This is a shape test on purpose. The behaviour it protects is decided by
 * GitHub and Railway, neither of which can be exercised from here, and one
 * `exit 1` added back in a hurry is exactly how the coupling would return.
 */

const WORKFLOW_PATH = ".github/workflows/back-merge-main-to-develop.yml";
const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8"));

test("no step in the back-merge workflow exits non-zero", () => {
  const offenders = [];
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.run !== "string") continue;
      for (const line of step.run.split("\n")) {
        // `exit 0` is fine and used deliberately; anything else ends the run
        // as a failure and takes a production deployment with it.
        const match = line.match(/(?:^|\s|;)exit\s+([0-9]+)/);
        if (match && match[1] !== "0") {
          offenders.push(`${jobId} / ${step.name}: ${line.trim()}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `${WORKFLOW_PATH} must not fail its run -- Railway's Wait for CI would skip the production deployment of an unrelated release:\n${offenders.join("\n")}`
  );
});

test("the guard can still raise an alarm", () => {
  const verify = workflow.jobs.verify;
  assert.equal(
    verify.permissions?.issues,
    "write",
    "the verify job opens the tracking issue that replaced the red X, so it needs issues: write"
  );

  const stepNames = (verify.steps ?? []).map((step) => step.name);
  assert.ok(
    stepNames.some((name) => /tracking issue/i.test(name)),
    `verify must keep a step that opens or refreshes the tracking issue; found: ${stepNames.join(", ")}`
  );
  assert.ok(
    (verify.steps ?? []).some((step) => /::error::/.test(step.run ?? "")),
    "verify must still annotate the run when the invariant is broken"
  );
});

test("the workflow still runs on every push to main", () => {
  assert.deepEqual(
    workflow.on.push.branches,
    ["main"],
    "the back-merge has to attempt itself on each release, whatever its run then reports"
  );
});
