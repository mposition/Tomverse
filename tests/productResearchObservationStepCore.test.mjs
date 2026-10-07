// What the observation step decides before it does anything.
//
// The failures these hold shut: a run that carries part of what it read, a
// clone that answered for a branch it does not have, a child process whose
// silence is read as success, and a failed slot carrying content.

import assert from "node:assert/strict";
import test from "node:test";

import {
  OBSERVATION_FAILURE_STAGES,
  OBSERVATION_ROW_LIMIT,
  OBSERVED_BRANCHES,
} from "../lib/productResearchObservationCore.mjs";
import { DEFAULT_RUN_TIMINGS } from "../lib/productResearchObservationRunnerCore.mjs";
import {
  ISSUE_FETCH_MAX_REQUESTS,
  ISSUE_FETCH_PER_PAGE,
  ISSUE_INPUT_MAX_BYTES,
  GIT_CALLS_PER_RUN,
  admitIssuePage,
  branchTipArgv,
  childFailureStage,
  cloneArgv,
  commitPresentArgv,
  issuesHeaders,
  issuesUrl,
  readBranchTip,
  readReport,
  reportArgv,
  submissionBody,
  worstCaseStepMs,
} from "../lib/productResearchObservationStepCore.mjs";

const issue = (number, extra = {}) => ({
  number,
  title: `Issue ${number}`,
  body: "",
  labels: [],
  ...extra,
});

test("the clone carries no credential and fetches no blobs up front", () => {
  const argv = cloneArgv("mposition/Tomverse", "/tmp/bare.git");
  assert.deepEqual(argv, [
    "clone",
    "--bare",
    "--filter=blob:none",
    "--no-tags",
    "https://github.com/mposition/Tomverse.git",
    "/tmp/bare.git",
  ]);
  // The URL carries no token and no user info: the repository is public, and
  // the read token exists for the REST rate limit rather than for access.
  const url = argv.find((part) => part.startsWith("https://"));
  assert.equal(url.includes("@"), false);
  assert.equal(url.includes("x-access-token"), false);
});

test("a branch with no readable tip is named, not guessed at", () => {
  assert.deepEqual(readBranchTip("develop", `${"a".repeat(40)}\n`), { sha: "a".repeat(40) });
  // "clone failed" and "that clone has no main" send an operator to different
  // places, so the problem names the branch.
  for (const output of ["", "   ", "not a sha", "a".repeat(39), undefined, null]) {
    const read = readBranchTip("main", output);
    assert.equal(read.sha, undefined, String(output));
    assert.match(read.problem, /^main /);
  }
  assert.deepEqual(branchTipArgv("develop"), ["rev-parse", "refs/heads/develop"]);
  assert.deepEqual(commitPresentArgv("b".repeat(40)), [
    "cat-file",
    "-e",
    `${"b".repeat(40)}^{commit}`,
  ]);
});

test("the issue read asks for open issues only, and says who it is", () => {
  const url = issuesUrl("mposition/Tomverse", 2);
  assert.match(url, /\/repos\/mposition\/Tomverse\/issues\?/);
  assert.match(url, /state=open/);
  assert.match(url, new RegExp(`per_page=${ISSUE_FETCH_PER_PAGE}`));
  assert.match(url, /page=2/);

  const headers = issuesHeaders("github_pat_example");
  assert.equal(headers.authorization, "Bearer github_pat_example");
  assert.match(headers["user-agent"], /product-research/);
  // A hundred per page against a 200-row limit is two pages; ten is a ceiling
  // that stops a paging bug from walking the API, not a target.
  assert.equal(ISSUE_FETCH_MAX_REQUESTS, 10);
});

test("a pull request is not backlog and never becomes a row", () => {
  const page = [issue(1), { ...issue(2), pull_request: { url: "x" } }, issue(3)];
  const admitted = admitIssuePage(page, []);
  assert.deepEqual(
    admitted.issues.map((entry) => entry.number),
    [1, 3],
  );
});

test("only the fields the report needs are held", () => {
  const admitted = admitIssuePage(
    [issue(1, { assignee: { login: "someone" }, user: { login: "author" }, state: "open" })],
    [],
  );
  // The author is a person, and the policy stores no issue field but the title.
  // Dropping the rest here means it is never written to the child's input file.
  assert.deepEqual(Object.keys(admitted.issues[0]).sort(), ["body", "labels", "number", "title"]);
});

test("a page that is not issues stops the run rather than being skipped", () => {
  for (const page of [null, undefined, {}, "", 7]) {
    assert.equal(admitIssuePage(page, []).stage, "issue_fetch_failed", String(page));
  }
  // An entry with no number or no title cannot become a row, and a run that
  // silently dropped it would report a backlog smaller than the real one.
  assert.equal(admitIssuePage([{ title: "no number" }], []).stage, "issue_fetch_failed");
  assert.equal(admitIssuePage([{ number: 1 }], []).stage, "issue_fetch_failed");
});

test("too many bytes and too many issues are each refused whole", () => {
  // A truncated observation is a wrong one, so neither case keeps what it read.
  const fat = [issue(1, { body: "x".repeat(ISSUE_INPUT_MAX_BYTES) })];
  const tooBig = admitIssuePage(fat, []);
  assert.equal(tooBig.stage, "issue_input_too_large");
  assert.equal(tooBig.issues, undefined);

  const many = Array.from({ length: OBSERVATION_ROW_LIMIT + 1 }, (_unused, index) => issue(index + 1));
  const tooMany = admitIssuePage(many, []);
  assert.equal(tooMany.stage, "row_count_exceeded");
  assert.equal(tooMany.issues, undefined);

  // Exactly at the row limit is not over it.
  const exact = Array.from({ length: OBSERVATION_ROW_LIMIT }, (_unused, index) => issue(index + 1));
  assert.equal(admitIssuePage(exact, []).issues.length, OBSERVATION_ROW_LIMIT);
});

test("bytes accumulate across pages, and a short page ends the paging", () => {
  const first = admitIssuePage([issue(1)], []);
  assert.equal(first.done, true, "a page shorter than a full one is the last");
  assert.ok(first.bytes > 0);

  // The cap is about what this run holds in total, not what one page carried.
  const full = Array.from({ length: ISSUE_FETCH_PER_PAGE }, (_unused, i) => issue(i + 1));
  const page1 = admitIssuePage(full, []);
  assert.equal(page1.done, false, "a full page might have another behind it");
  const page2 = admitIssuePage([issue(999)], page1.issues, { bytes: page1.bytes });
  assert.equal(page2.issues.length, ISSUE_FETCH_PER_PAGE + 1);
  assert.ok(page2.bytes > page1.bytes);
  assert.equal(page2.done, true);
});

test("a child that failed is not read as an empty backlog", () => {
  // The report prints nothing on stdout when it refuses, so an empty stdout
  // with a non-zero status must not parse as "no open issues".
  const failed = readReport({ status: 1, stdout: "" });
  assert.equal(failed.stage, "issue_backlog_failed");
  assert.match(failed.detail, /exited 1/);

  for (const stdout of ["", "not json", "[]", '{"ok":true}', "null"]) {
    const read = readReport({ status: 0, stdout });
    assert.equal(read.report, undefined, stdout);
    assert.equal(read.stage, "schema_invalid", stdout);
  }

  const good = readReport({ status: 0, stdout: JSON.stringify({ classified: [] }) });
  assert.deepEqual(good.report, { classified: [] });
});

test("the report is told which commits to read, not which branches", () => {
  const argv = reportArgv({
    cli: "/app/scripts/report-issue-backlog.mjs",
    repository: "/tmp/bare.git",
    issuesFile: "/tmp/issues.json",
    develop: "a".repeat(40),
    main: "b".repeat(40),
  });
  assert.ok(argv.includes("--json"));
  assert.equal(argv[argv.indexOf("--repository") + 1], "/tmp/bare.git");
  // Pins, not names: the report reads those exact commits rather than whatever
  // the branch names point at while it runs.
  assert.deepEqual(
    argv.filter((part) => part.startsWith("develop=") || part.startsWith("main=")),
    [`develop=${"a".repeat(40)}`, `main=${"b".repeat(40)}`],
  );
});

test("a failed slot's body has nowhere to put content", () => {
  const failed = submissionBody({
    schemaVersion: 1,
    slot: "2026-10-07T21:30:00.000Z",
    failureStage: "clone_failed",
  });
  assert.deepEqual(Object.keys(failed).sort(), [
    "failureStage",
    "outcome",
    "schemaVersion",
    "slot",
  ]);
  assert.equal(failed.outcome, "failed");
  assert.ok(OBSERVATION_FAILURE_STAGES.includes(failed.failureStage));

  const ok = submissionBody({
    slot: "2026-10-07T21:30:00.000Z",
    developSha: "a".repeat(40),
    mainSha: "b".repeat(40),
    payload: { schemaVersion: 1, issues: [], counts: {}, blindSpots: {} },
  });
  assert.deepEqual(Object.keys(ok).sort(), [
    "developSha",
    "mainSha",
    "outcome",
    "payload",
    "schemaVersion",
    "slot",
  ]);
  assert.equal(ok.outcome, "ok");
  // No digest: the server computes it from what it stores, and a body carrying
  // one is refused rather than having it ignored.
  assert.equal("payloadDigest" in ok, false);
});

test("every stage this module can name is in the closed list", () => {
  // A stage is stored and displayed with a label of its own, so one invented
  // here would be a value the database refuses and the screen cannot render.
  const named = ["issue_fetch_failed", "issue_input_too_large", "row_count_exceeded", "issue_backlog_failed", "schema_invalid"];
  for (const stage of named) {
    assert.ok(OBSERVATION_FAILURE_STAGES.includes(stage), stage);
  }
});

test("the report child runs under node's own type stripping, not tsx", () => {
  const argv = reportArgv({
    cli: "/app/scripts/report-issue-backlog.mjs",
    repository: "/tmp/bare.git",
    issuesFile: "/tmp/issues.json",
    develop: "a".repeat(40),
    main: "b".repeat(40),
  });
  // `tsx` is a devDependency. An image built with NODE_ENV=production has none,
  // so a run that depended on it would fail only where it actually runs.
  assert.deepEqual(argv.slice(0, 2), ["--experimental-strip-types", "/app/scripts/report-issue-backlog.mjs"]);
  assert.equal(argv.includes("tsx"), false);
  assert.equal(argv.some((part) => part.includes("--import")), false);
});

test("every step's own deadline fits inside the run's preparation deadline", () => {
  // A per-step timeout that looks generous on its own can add up past the
  // preparation deadline, and then the watchdog ends the run instead of the
  // step naming itself: the row would say `timeout` for something that has a
  // stage of its own.
  assert.ok(
    worstCaseStepMs() <= DEFAULT_RUN_TIMINGS.prepareMs,
    `${worstCaseStepMs()}ms of steps against a ${DEFAULT_RUN_TIMINGS.prepareMs}ms deadline`,
  );
  // And it is not so far inside that a step could be given a real timeout the
  // sum would hide: the check is worth having only while it is close.
  assert.ok(worstCaseStepMs() > DEFAULT_RUN_TIMINGS.prepareMs / 2);
  assert.equal(GIT_CALLS_PER_RUN, 2 * OBSERVED_BRANCHES.length);
});

test("a killed child is a timeout and a missing binary is not", () => {
  // `spawnSync` reports both as "no status", and reading that as a timeout
  // would say a deadline was reached in an image that has no git at all.
  assert.equal(childFailureStage({ error: { code: "ETIMEDOUT" } }, "clone_failed"), "timeout");
  assert.equal(childFailureStage({ signal: "SIGTERM" }, "clone_failed"), "timeout");
  assert.equal(childFailureStage({ status: null, error: { code: "ENOENT" } }, "clone_failed"), "clone_failed");
  assert.equal(childFailureStage({ status: 1, signal: null }, "issue_backlog_failed"), "issue_backlog_failed");
});
