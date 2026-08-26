import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { parse } from "yaml";

/**
 * The back-merge workflow must not fail its own run.
 *
 * Railway deploys `main` with Wait for CI, and that rule is all-or-nothing:
 * any failing workflow on the commit turns the pending deployment into
 * SKIPPED, and Railway offers no way to say which workflows are the release
 * verdict. So for as long as this run could fail, a conflict between `main`
 * and `develop` -- which says nothing about whether `main` is deployable --
 * cancelled the production deployment of whichever release was waiting: #953,
 * #954, #960, #968 and #969 on 2026-08-25, then #1023 on 2026-08-26.
 *
 * `continue-on-error` at the job level is what separates them, and it is two
 * lines that read like a tidy-up. This file is why they stay.
 *
 * Note what is NOT asserted here: that the jobs stop failing. They still do,
 * and they must -- `scripts/security-regression-check.mjs` pins the conflict
 * path's `exit 1` and its ordering, and that check is the authority on this
 * workflow's behaviour. The only thing this file adds is the run's verdict.
 */

const WORKFLOW_PATH = ".github/workflows/back-merge-main-to-develop.yml";
const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8"));

test("every job allows its own failure, so the run stays green", () => {
  const offenders = Object.entries(workflow.jobs)
    .filter(([, job]) => job["continue-on-error"] !== true)
    .map(([jobId]) => jobId);

  assert.deepEqual(
    offenders,
    [],
    `${WORKFLOW_PATH}: ${offenders.join(", ")} can fail the run, and Railway's Wait for CI would skip the production deployment of an unrelated release`
  );
});

test("the guard still fails its job, and still reports", () => {
  const verify = workflow.jobs.verify;

  // `if: always()` was load-bearing before and is more so now: `verify`
  // needs a job that is an allowed failure, so without this it would be
  // skipped exactly when the invariant most needs reporting.
  assert.equal(verify.if, "always()", "verify must run after a failed back-merge");

  const assertStep = (verify.steps ?? []).find((step) => step.id === "invariant");
  assert.ok(assertStep, "verify must keep the step that decides the invariant");
  assert.match(
    assertStep.run,
    /git merge-base --is-ancestor origin\/main origin\/develop/,
    "the invariant is decided from git, not from the job above it"
  );
  assert.match(
    assertStep.run,
    /exit 1/,
    "the assert step still fails its job -- only the run's conclusion changed"
  );

  // Making the run green must not quiet the alert. The notifier keys off this
  // step's own outcome rather than `job.status` for exactly that reason.
  const alert = (verify.steps ?? []).find((step) =>
    /notify-release-lane-failure/.test(step.run ?? "")
  );
  assert.ok(alert, "verify must keep the step that pages on a red lane");
  assert.match(
    alert.if ?? "",
    /steps\.invariant\.outcome == 'failure'/,
    "the alert must key off the assert step's outcome, not the job's or the run's status"
  );
});

test("the workflow still runs on every push to main", () => {
  assert.deepEqual(
    workflow.on.push.branches,
    ["main"],
    "the back-merge has to attempt itself on each release, whatever its run then reports"
  );
});
