/**
 * docs/policy/engineering-agent.md §5's cache isolation record.
 *
 * Signing it widens what the engineering agent may push, and the signature is
 * one edit in one file. These tests are what make that edit safe: the record
 * cannot be signed into a state where the condition it rests on is false, and
 * it cannot be signed while saying something §5 forbids.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CACHE_ISOLATION_DIRECTION_FACTS,
  CACHE_ISOLATION_RECORD,
  cacheIsolationRecordSignature,
} from "../lib/agentCacheIsolationRecord.ts";
import { analyseCredentialReachability } from "../lib/agentCredentialReachability.ts";

import { judgeAgentPrCacheIsolation } from "../scripts/agent-pr-cache-isolation-policy.mjs";

const signed = (overrides = {}) => ({
  ...CACHE_ISOLATION_RECORD,
  approvedBy: "@mposition",
  approvedAt: "2026-10-04T00:00:00Z",
  ...overrides,
});

/* ------------------------------------------------------------------------- */
/* The signature                                                             */
/* ------------------------------------------------------------------------- */

test("the committed record is unsigned, so it lifts nothing", () => {
  const verdict = cacheIsolationRecordSignature();
  assert.equal(verdict.signed, false, "the record in the tree must not be signed by a change like this one");
  assert.deepEqual(verdict.problems, ["unsigned_approved_at", "unsigned_approved_by"]);
});

test("filling both fields is the whole of the owner's act", () => {
  // The point of the draft: everything else is already in place, so signing is
  // two values in one file and nothing more.
  assert.deepEqual(cacheIsolationRecordSignature(signed()), { signed: true, problems: [] });
});

test("half a signature is not one", () => {
  assert.equal(cacheIsolationRecordSignature(signed({ approvedAt: "" })).signed, false);
  assert.equal(cacheIsolationRecordSignature(signed({ approvedBy: "  " })).signed, false);
});

test("the approval instant must be a UTC instant, not a day or a local time", () => {
  for (const approvedAt of ["2026-10-04", "2026-10-04T10:00:00+10:00", "yesterday", "2026-10-04 00:00:00Z"]) {
    const verdict = cacheIsolationRecordSignature(signed({ approvedAt }));
    assert.equal(verdict.signed, false, approvedAt);
    assert.ok(verdict.problems.includes("approved_at_not_a_utc_instant"), approvedAt);
  }
  assert.equal(cacheIsolationRecordSignature(signed({ approvedAt: "2026-10-04T00:00Z" })).signed, true);
});

/* ------------------------------------------------------------------------- */
/* What the record has to say                                                */
/* ------------------------------------------------------------------------- */

test("all three directions are present, and each states its own openness", () => {
  const names = Object.keys(CACHE_ISOLATION_DIRECTION_FACTS);
  assert.deepEqual(
    CACHE_ISOLATION_RECORD.directions.map((entry) => entry.direction).sort(),
    [...names].sort(),
    "§5 requires three directions, each established on its own",
  );
  for (const entry of CACHE_ISOLATION_RECORD.directions) {
    assert.equal(entry.open, CACHE_ISOLATION_DIRECTION_FACTS[entry.direction], entry.direction);
    assert.ok(entry.finding.trim().length > 0, entry.direction);
    assert.ok(entry.basis.trim().length > 0, entry.direction);
  }
});

test("a direction cannot be signed with the wrong openness, or left out", () => {
  const without = (name) => CACHE_ISOLATION_RECORD.directions.filter((entry) => entry.direction !== name);
  for (const name of Object.keys(CACHE_ISOLATION_DIRECTION_FACTS)) {
    const missing = cacheIsolationRecordSignature(signed({ directions: without(name) }));
    assert.equal(missing.signed, false, name);
    assert.ok(missing.problems.includes(`direction_missing:${name}`), name);

    const flipped = CACHE_ISOLATION_RECORD.directions.map((entry) =>
      entry.direction === name ? { ...entry, open: !entry.open } : entry,
    );
    const wrong = cacheIsolationRecordSignature(signed({ directions: flipped }));
    assert.equal(wrong.signed, false, name);
    assert.ok(wrong.problems.includes(`direction_states_wrong_openness:${name}`), name);
  }
});

test("the record may not claim caches are isolated between refs", () => {
  // §5 says this sentence is false and names it as the one that must not
  // appear: the default-branch and base directions are open.
  const claiming = CACHE_ISOLATION_RECORD.directions.map((entry) =>
    entry.direction === "pull_request_to_other_ref"
      ? { ...entry, basis: "Actions caches are isolated between refs." }
      : entry,
  );
  const verdict = cacheIsolationRecordSignature(signed({ directions: claiming }));
  assert.equal(verdict.signed, false);
  assert.ok(verdict.problems.includes("claims_isolation_between_refs"));
});

test("the record names no workflow and no job, because this repository is public", () => {
  // docs/policy/engineering-agent.md §16 keeps the list of unresolved
  // reachability targets out of this repository. The record carries counts.
  const source = readFileSync(new URL("../lib/agentCacheIsolationRecord.ts", import.meta.url), "utf8");
  // The workflow path is the identifying half, so this is the substantive check.
  assert.doesNotMatch(source, /\.ya?ml/, "a workflow file name reached the record");
  assert.doesNotMatch(source, /\.github\/workflows/);

  const committed = analyseCredentialReachability({
    workflows: committedWorkflows(),
    exclusions: [],
    cacheIsolationRecorded: false,
  });
  assert.equal(committed.status, "analysed");
  // Only job ids that are identifiers rather than ordinary words. Several jobs
  // here are named `run`, `record` or `report`, and prose that happens to
  // contain those words identifies nothing -- asserting on them would fail this
  // test on an English sentence and teach the next reader to delete it.
  const identifying = [...new Set(committed.credentialedJobs.map((entry) => entry.jobId))].filter(
    (jobId) => /[-_]/.test(jobId) || jobId.length >= 10,
  );
  assert.ok(identifying.length > 0, "expected some job ids distinctive enough to be worth checking");
  for (const jobId of identifying) {
    assert.ok(!source.includes(jobId), `a job id ${jobId.length} characters long reached the record`);
  }
});

/* ------------------------------------------------------------------------- */
/* The condition the record rests on                                         */
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

test("the record cannot be signed into a state where its third direction is false", () => {
  // This is the test that makes the one-edit signature safe. §5's third
  // direction rests on "no credentialed job that can run on the agent's own
  // pull request restores any cache", and that is a property of the workflows
  // in the tree, not of the record. If it stops holding, a signature must stop
  // counting -- so the two are checked together here as well as at the point
  // of use in scripts/report-engineering-agent-tiers.mjs.
  const blind = analyseCredentialReachability({
    workflows: committedWorkflows(),
    exclusions: [],
    cacheIsolationRecorded: false,
  });
  const narrow = judgeAgentPrCacheIsolation(blind);
  assert.equal(narrow.status, "judged");
  const signature = cacheIsolationRecordSignature();
  assert.equal(
    signature.signed && !narrow.held,
    false,
    "the cache isolation record is signed while a credentialed job that can run on the agent's own pull " +
      "request restores a cache; npm run check:agent-pr-cache-isolation names the counts",
  );
});

test("the record's verified commit is a full sha this repository has", () => {
  assert.match(CACHE_ISOLATION_RECORD.verifiedAtCommit, /^[0-9a-f]{40}$/);
  // A record whose measurement cannot be located is not evidence.
  const type = git(["cat-file", "-t", CACHE_ISOLATION_RECORD.verifiedAtCommit]).trim();
  assert.equal(type, "commit");
});

test("applying the record is blind-first, so signing cannot hide its own evidence", () => {
  // An analysis taken with the record applied reports no cache reasons at all,
  // so the narrow judgement would read "held" because the evidence was hidden
  // rather than because the condition is true. The consumer must judge the
  // blind analysis first.
  const workflows = committedWorkflows();
  const applied = analyseCredentialReachability({ workflows, exclusions: [], cacheIsolationRecorded: true });
  const verdict = judgeAgentPrCacheIsolation(applied);
  assert.equal(verdict.status, "judged");
  assert.equal(verdict.held, true, "this is the wrong answer, reached by hiding the evidence");
  assert.equal(verdict.cacheRestoringJobsAnywhereCount, 0, "and it cannot see the jobs the blind analysis reports");

  const consumer = readFileSync(new URL("../scripts/report-engineering-agent-tiers.mjs", import.meta.url), "utf8");
  assert.match(consumer, /judgeAgentPrCacheIsolation\(blind\)/, "the consumer must judge the blind analysis");
  assert.match(consumer, /signature\.signed && narrow\.status === "judged" && narrow\.held/);
});
