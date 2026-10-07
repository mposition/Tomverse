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
  TITLE_MAX_CODE_POINTS,
} from "../lib/productResearchObservationCore.mjs";
import { DEFAULT_RUN_TIMINGS } from "../lib/productResearchObservationRunnerCore.mjs";
import {
  ISSUE_FETCH_MAX_REQUESTS,
  ISSUE_FETCH_PER_PAGE,
  ISSUE_INPUT_MAX_BYTES,
  ISSUE_RECEIVED_MAX_BYTES,
  GIT_CALLS_PER_RUN,
  admitIssuePage,
  admitReceivedBytes,
  branchTipArgv,
  childFailureStage,
  cloneArgv,
  commitPresentArgv,
  issuesHeaders,
  issuesUrl,
  readBranchTip,
  readLimitedBody,
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

test("only the two fields the report reads are held", () => {
  const admitted = admitIssuePage(
    [
      issue(1, {
        assignee: { login: "someone" },
        user: { login: "author" },
        state: "open",
        body: "x".repeat(5_000),
        labels: [{ name: "bug" }],
      }),
    ],
    [],
  );
  // The report maps its input to `{ number, title }` and discards the rest, so
  // anything else held is the user's text carried for no reason -- and, when it
  // was `body`, enough of it to refuse an ordinary backlog.
  assert.deepEqual(Object.keys(admitted.issues[0]).sort(), ["number", "title"]);
});

test("a backlog at the row limit fits inside the held byte cap", () => {
  // The two caps have to agree. They did not: with bodies held, eleven real
  // issues came to 52,769 bytes and the byte cap would have fired at about
  // twenty, so the 200-row limit named by the policy could never be reached and
  // an ordinary backlog would have been refused as `issue_input_too_large`.
  const longest = Array.from({ length: OBSERVATION_ROW_LIMIT }, (_unused, index) =>
    issue(index + 1, { title: "t".repeat(TITLE_MAX_CODE_POINTS) }),
  );
  const admitted = admitIssuePage(longest, []);
  assert.equal(admitted.issues?.length, OBSERVATION_ROW_LIMIT, admitted.stage);
  assert.ok(
    admitted.bytes < ISSUE_INPUT_MAX_BYTES,
    `${admitted.bytes} of ${ISSUE_INPUT_MAX_BYTES} bytes at the row limit`,
  );
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
  // The weight is in the title because the title is one of the two fields held;
  // a long body is dropped before it is measured, which is the point of holding
  // only what the report reads.
  const fat = [issue(1, { title: "x".repeat(ISSUE_INPUT_MAX_BYTES) })];
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

test("a full page is not the last one because a pull request was in it", () => {
  // The defect this holds shut: `done` read from the filtered list meant one
  // pull request among a hundred entries ended the paging, and the run then
  // submitted a successful row missing every issue behind it. A success that
  // silently drops backlog is worse than a failed slot.
  const full = [
    { ...issue(1), pull_request: { url: "x" } },
    ...Array.from({ length: ISSUE_FETCH_PER_PAGE - 1 }, (_unused, i) => issue(i + 2)),
  ];
  assert.equal(full.length, ISSUE_FETCH_PER_PAGE);
  const admitted = admitIssuePage(full, []);
  assert.equal(admitted.issues.length, ISSUE_FETCH_PER_PAGE - 1, "the pull request is not backlog");
  assert.equal(admitted.done, false, "a full page might have another behind it");

  // And a page the API actually ended short is still the last one.
  const short = Array.from({ length: ISSUE_FETCH_PER_PAGE - 1 }, (_unused, i) => issue(i + 1));
  assert.equal(admitIssuePage(short, []).done, true);
});

test("the bytes received are bounded separately from the bytes held", () => {
  // Two different questions. The held cap is about what is written for the
  // child; this one is about what is read into memory, and a cap checked after
  // `response.json()` has bounded nothing -- which is what the first version
  // of this did.
  assert.ok(ISSUE_RECEIVED_MAX_BYTES > ISSUE_INPUT_MAX_BYTES);
  assert.deepEqual(admitReceivedBytes(0, 1024), { received: 1024 });
  assert.deepEqual(admitReceivedBytes(ISSUE_RECEIVED_MAX_BYTES, 0), {
    received: ISSUE_RECEIVED_MAX_BYTES,
  });
  const over = admitReceivedBytes(ISSUE_RECEIVED_MAX_BYTES, 1);
  assert.equal(over.stage, "issue_input_too_large");
  assert.equal(over.received, undefined);
  assert.ok(OBSERVATION_FAILURE_STAGES.includes(over.stage));
});

test("an entry the page reader cannot read stops the run", () => {
  // Not skipped. A non-object entry dropped quietly would report a backlog
  // smaller than the real one while looking exactly like a correct read.
  for (const entry of [null, 7, "an issue", []]) {
    const admitted = admitIssuePage([issue(1), entry], []);
    assert.equal(admitted.stage, "issue_fetch_failed", JSON.stringify(entry));
    assert.equal(admitted.issues, undefined);
  }
});

test("a body past its allowance is refused before it is parsed", async () => {
  const chunked = (parts) =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
          controller.close();
        },
      }),
    );

  // Within the allowance: read whole, with the byte count the caller adds to
  // its running total.
  const small = await readLimitedBody(chunked(['[{"number":1}]']), 1024);
  assert.equal(small.text, '[{"number":1}]');
  assert.equal(small.bytes, 14);

  // Past it: refused at the chunk that crossed the line, so the rest of the
  // body is never read and never held. The text is not returned at all --
  // returning what fitted is how a truncated observation would get parsed.
  const big = await readLimitedBody(chunked(["0123456789", "0123456789"]), 15);
  assert.equal(big.tooLarge, 20);
  assert.equal(big.text, undefined);

  // Exactly the allowance is not past it.
  const exact = await readLimitedBody(chunked(["0123456789"]), 10);
  assert.equal(exact.text, "0123456789");

  // A response with no body is a fetch problem, not an empty issue list.
  assert.match((await readLimitedBody({ body: null }, 1024)).problem, /no body/);
  assert.match((await readLimitedBody(undefined, 1024)).problem, /no body/);
});

test("a body stream that fails mid-read answers instead of throwing", async () => {
  // The regression this holds shut: `response.json()` was inside a try/catch
  // and the chunked reader that replaced it was not. A connection that drops
  // after the headers arrived, or a request timeout firing mid-body, would then
  // travel past every failure stage and end the process with no row at all --
  // the one outcome a nameable failure may not have.
  const failing = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('[{"number":1}'));
        controller.error(new Error("https://api.github.com/... with a header on it"));
      },
    }),
  );
  const read = await readLimitedBody(failing, 1024);
  assert.match(read.problem, /could not be read to the end/);
  assert.equal(read.text, undefined);
  // And the reason does not come out: a stream error's message can name the
  // request, and the request carries the token's header.
  assert.equal(/api\.github\.com/.test(read.problem), false);

  // An aborted request is the same answer rather than a rejection.
  const controller = new AbortController();
  controller.abort();
  let aborted;
  try {
    aborted = await readLimitedBody(
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode("["));
            stream.error(controller.signal.reason);
          },
        }),
      ),
      1024,
    );
  } catch (error) {
    assert.fail(`readLimitedBody threw: ${error?.name}`);
  }
  assert.ok(aborted.problem);
});
