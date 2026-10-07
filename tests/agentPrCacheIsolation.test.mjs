/**
 * The device docs/policy/engineering-agent.md §5's cache isolation record needs
 * for its third direction: no credentialed job that can run on the engineering
 * agent's own pull request restores an Actions cache.
 *
 * .github/audits/actions-cache-poisoning-audit-2026-10-03.md P7 is why it
 * exists, and P3 is why it judges through lib/agentCredentialReachability.ts
 * instead of reading the workflows a second time.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { analyseCredentialReachability } from "../lib/agentCredentialReachability.ts";

import { judgeAgentPrCacheIsolation } from "../scripts/agent-pr-cache-isolation-policy.mjs";

const wf = (name, text) => ({ path: `.github/workflows/${name}.yml`, blobSha: "a".repeat(40), text });
const analyse = (workflows, overrides = {}) =>
  analyseCredentialReachability({ workflows, exclusions: [], cacheIsolationRecorded: false, ...overrides });

/** A credentialed job restoring the npm cache, on the agent's own pull request. */
const REACHED_WITH_NPM_CACHE = `
name: reached
on:
  pull_request:
    branches: [develop]
permissions:
  contents: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm
      - run: npm ci
`;

/** The same job, on a branch the agent cannot push and a base it cannot target. */
const UNREACHED_WITH_NPM_CACHE = REACHED_WITH_NPM_CACHE.replace(
  `  pull_request:
    branches: [develop]`,
  `  schedule:
    - cron: "0 3 * * *"`,
).replace("name: reached", "name: unreached");

/* ------------------------------------------------------------------------- */
/* The core judgement                                                         */
/* ------------------------------------------------------------------------- */

test("a verified package-manager cache is refused when the job can run on the agent's pull request", () => {
  const verdict = judgeAgentPrCacheIsolation(analyse([wf("reached", REACHED_WITH_NPM_CACHE)]));
  assert.equal(verdict.status, "judged");
  assert.equal(verdict.held, false);
  assert.equal(verdict.offenders.length, 1);
  assert.deepEqual(verdict.offenders[0].cacheKinds, ["verified_package_manager"]);
  assert.equal(verdict.kindDistribution, "verified_package_manager=1");
});

test("the same cache in a workflow no agent event reaches is not this check's question", () => {
  const verdict = judgeAgentPrCacheIsolation(analyse([wf("unreached", UNREACHED_WITH_NPM_CACHE)]));
  assert.equal(verdict.status, "judged");
  assert.equal(verdict.held, true, "unreached is this check's pass, not its failure");
  assert.equal(verdict.reachedWorkflowCount, 0);
  assert.equal(
    verdict.cacheRestoringJobsAnywhereCount,
    1,
    "policy §5 still forbids every change for it; this check reports it rather than clearing it",
  );
});

test("an unverified cache is refused too, and the two kinds are counted apart", () => {
  const unverified = REACHED_WITH_NPM_CACHE.replace(
    `      - uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm`,
    `      - uses: actions/cache@v4
        with:
          path: .next/cache
          key: next-\${{ github.sha }}`,
  );
  const verdict = judgeAgentPrCacheIsolation(
    analyse([wf("a", REACHED_WITH_NPM_CACHE), wf("b", unverified.replace("name: reached", "name: other"))]),
  );
  assert.equal(verdict.held, false);
  assert.equal(verdict.offenders.length, 2);
  assert.equal(verdict.kindDistribution, "unverified=1, verified_package_manager=1");
});

test("a job with the cache but no credential is not an offender", () => {
  const readOnly = REACHED_WITH_NPM_CACHE.replace("  contents: write", "  contents: read");
  const verdict = judgeAgentPrCacheIsolation(analyse([wf("reached", readOnly)]));
  assert.equal(verdict.held, true);
  assert.equal(verdict.reachedWorkflowCount, 1, "the workflow is still reached; only the credential is gone");
});

test("a job's condition is not read, so a condition that keeps it off an agent branch does not clear it", () => {
  // The shape that makes this tempting: a workflow reached by the agent's own
  // pull request closing, with the job gated on a head ref the agent never
  // has. Policy §5 forbids the analyser from interpreting that, and the audit's
  // F5 went wrong twice by reading a trigger without its condition.
  const gated = REACHED_WITH_NPM_CACHE.replace(
    "  build:\n    runs-on: ubuntu-latest",
    "  build:\n    if: startsWith(github.event.pull_request.head.ref, 'feedback-autofix/')\n    runs-on: ubuntu-latest",
  );
  const verdict = judgeAgentPrCacheIsolation(analyse([wf("reached", gated)]));
  assert.equal(verdict.held, false, "the condition must not be what makes this pass");
  assert.equal(verdict.offenders.length, 1);
});

/* ------------------------------------------------------------------------- */
/* Failing closed                                                            */
/* ------------------------------------------------------------------------- */

test("an analysis that failed, or that cannot say what is reached, is unanalysable rather than a pass", () => {
  assert.deepEqual(
    judgeAgentPrCacheIsolation({ status: "failed", problems: [{ path: "a", problem: "yaml_unparseable" }] }),
    { status: "unanalysable", problemCount: 1 },
  );
  assert.equal(judgeAgentPrCacheIsolation(null).status, "unanalysable");
  // A result shaped like a pass but missing the field this asks about must not
  // answer "nothing is reached, so nothing restores a cache".
  const real = analyse([wf("reached", REACHED_WITH_NPM_CACHE)]);
  const withoutReach = Object.fromEntries(
    Object.entries(real).filter(([key]) => key !== "reachedWorkflows"),
  );
  assert.equal(judgeAgentPrCacheIsolation(withoutReach).status, "unanalysable");
  assert.equal(judgeAgentPrCacheIsolation({ ...real, reasons: undefined }).status, "unanalysable");
});

test("a recorded isolation blinds the analysis, which is why the check must pass false", () => {
  // The record is only true while this check holds. If the check read the
  // record, writing the record would switch off the device that keeps it true.
  const blinded = judgeAgentPrCacheIsolation(
    analyse([wf("reached", REACHED_WITH_NPM_CACHE)], { cacheIsolationRecorded: true }),
  );
  assert.equal(blinded.held, true, "this is the wrong answer, reached by hiding the evidence");
  const seeing = judgeAgentPrCacheIsolation(analyse([wf("reached", REACHED_WITH_NPM_CACHE)]));
  assert.equal(seeing.held, false);

  const source = readFileSync(new URL("../scripts/check-agent-pr-cache-isolation.mjs", import.meta.url), "utf8");
  assert.match(source, /cacheIsolationRecorded:\s*false/, "the check must take the analysis with the record ignored");
  assert.doesNotMatch(source, /cacheIsolationRecorded:\s*true/);
});

/* ------------------------------------------------------------------------- */
/* This repository                                                           */
/* ------------------------------------------------------------------------- */

const root = new URL("..", import.meta.url);
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const committedWorkflows = () =>
  git(["ls-tree", "-r", "HEAD", ".github/workflows"])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      const blobSha = meta.split(" ")[2];
      return { path, blobSha, text: git(["cat-file", "blob", blobSha]) };
    })
    .filter((file) => /\.ya?ml$/.test(file.path));

test("on this repository's committed workflows the condition holds", () => {
  const verdict = judgeAgentPrCacheIsolation(analyse(committedWorkflows()));
  assert.equal(verdict.status, "judged");
  assert.equal(
    verdict.offenders.length,
    0,
    "a credentialed job that can run on the agent's pull request restores a cache again; " +
      "docs/policy/engineering-agent.md §5 forbids the cache isolation record while that is true",
  );
  assert.ok(verdict.reachedWorkflowCount > 0, "expected the question to be exercised");
  assert.ok(verdict.credentialedJobsInReachedCount > 0, "expected credentialed jobs in reach");
  // This used to assert the wider count was above zero, so that the narrow
  // verdict's zero read as a real distinction rather than a coincidence. It is
  // zero now: the owner's §16 decision took the npm cache off the remaining ten
  // credentialed jobs, which this check never asked about and §5 forbids all
  // the same. The contrast moved to the synthetic case below; here the stronger
  // state is asserted as the fact it is. Whether §5's record may now be written
  // is a reading of that policy and an owner's act, not something this follows
  // from. .github/audits/actions-cache-poisoning-audit-2026-10-03.md 4.3, 10.
  assert.equal(verdict.cacheRestoringJobsAnywhereCount, 0);
});

test("the narrow question stays distinct from the wider rule, on built workflows", () => {
  // The distinction the assertion above used to carry: a credentialed job that
  // restores a cache somewhere the agent's pull request cannot reach leaves
  // this check with no offender while §5's wider rule still refuses every
  // change. If these two ever collapse into one number, this check has stopped
  // answering its own question.
  const unreached = REACHED_WITH_NPM_CACHE.replace(
    `on:
  pull_request:
    branches: [develop]`,
    `on:
  schedule:
    - cron: '0 1 * * *'`,
  );
  const verdict = judgeAgentPrCacheIsolation(analyse([wf("reached", REACHED_WITH_NPM_CACHE), wf("elsewhere", unreached)]));
  assert.equal(verdict.status, "judged");
  assert.equal(verdict.cacheRestoringJobsAnywhereCount, 2, "both jobs restore a cache");
  assert.equal(verdict.offenders.length, 1, "only the one an agent pull request reaches is this check's offender");
});

test("the check names no workflow and no job, because this repository is public", () => {
  // docs/policy/engineering-agent.md §16 keeps the list of unresolved
  // reachability targets out of this repository, and a check that prints its
  // findings would publish exactly that list on every run.
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "--conditions=react-server", "scripts/check-agent-pr-cache-isolation.mjs"],
    { cwd: root, encoding: "utf8" },
  );
  assert.doesNotMatch(output, /\.ya?ml/, "a workflow file name reached the output");
  assert.doesNotMatch(output, /\.github\/workflows/);
  for (const job of new Set(analyse(committedWorkflows()).credentialedJobs.map((entry) => entry.jobId))) {
    assert.ok(!output.includes(job), `the job id ${job.length} characters long reached the output`);
  }
  assert.match(output, /passed/);
});
