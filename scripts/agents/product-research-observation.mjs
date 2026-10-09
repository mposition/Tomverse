// The product-research observation runner, as the Agent project's cron runs it.
//
// This file is the IO and the timers; every decision it makes is in
// lib/productResearchObservationRunnerCore.mjs, which is tested without a
// clock, a network or git. Keep it that way -- a judgement added here is one
// the tests cannot reach.
//
// Railway's cron skips the next run while one is still going and never ends the
// one that hung, so a run that stops making progress silently stops every run
// after it. The hard deadline below is what makes that impossible: the process
// exits at it whatever state it is in, and a normal finish clears both timers
// rather than waiting for them.
//
// Two modes:
//   (default)  plan the run from the environment, and do it.
//   --probe    measure what the deployed image can do and print it. Submits
//              nothing, and the probe service has no submission variables to
//              submit with.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_RUN_TIMINGS,
  childEnvironment,
  createRunState,
  gitSupportsPartialClone,
  planProbe,
  planRun,
  runTimingProblems,
  slotForInstant,
  systemNamesForPlatform,
} from "../../lib/productResearchObservationRunnerCore.mjs";
import {
  OBSERVATION_SCHEMA_VERSION,
  OBSERVED_BRANCHES,
  buildObservationPayload,
  observationPayloadDigest,
} from "../../lib/productResearchObservationCore.mjs";
import { endChild, runChild } from "../../lib/productResearchObservationChild.mjs";
import {
  ISSUE_FETCH_MAX_REQUESTS,
  ISSUE_RECEIVED_MAX_BYTES,
  OBSERVED_REPOSITORY,
  REPORT_MAX_BUFFER_BYTES,
  STEP_TIMINGS,
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
  readSubmissionReceipt,
  reportArgv,
  submissionBody,
} from "../../lib/productResearchObservationStepCore.mjs";

const PROBE = process.argv.slice(2).includes("--probe");

/** Printed to the deploy log. Never a variable's value. */
const say = (line) => {
  process.stdout.write(`${line}\n`);
};

/**
 * What the deployed image can actually do.
 *
 * S0 exists because the deployed image has no `git` binary unless the builder
 * installs one, and a clone is how this agent reads a pinned commit. The probe
 * reports the fact rather than asserting it: an image that cannot clone is a
 * reason to hold the phase, not to fail silently at 21:30.
 */
const probeImage = async () => {
  // `runChild` gives it the same narrowed environment every other child gets:
  // `git --version` has no reason to see the service's token.
  const version = await run("git", ["--version"], { timeoutMs: 10_000 });
  const gitAvailable = version.status === 0;
  say(`git available: ${gitAvailable}`);
  if (gitAvailable) say(`git version: ${version.stdout.trim()}`);
  else if (version.error) say(`git lookup failed: ${version.error.code ?? "unknown"}`);

  // The clone the agent would make needs --filter=blob:none specifically, and
  // an old git has the binary without it. Decided from the version string: a
  // `git clone --filter=... --help` exits on whether a manual page opened.
  if (gitAvailable) {
    say(`partial clone supported: ${gitSupportsPartialClone(version.stdout)}`);
  }

  say(`node version: ${process.version}`);
  say(`slot this run would answer for: ${slotForInstant(Date.now())}`);
  return gitAvailable ? 0 : 1;
};

/**
 * The child this run is waiting on, so a watchdog can end it.
 *
 * A deadline that cannot reach the thing it is waiting for is not a deadline.
 */
let liveChild = null;

/** Every child of this run: narrowed environment, tracked, and endable. */
const run = (command, argv, options = {}) =>
  runChild(command, argv, {
    ...options,
    // Not the whole environment. A child that inherits everything is a child
    // that can print anything, and git clones a public repository here.
    env: childEnvironment(process.env, { platform: process.platform }),
    onStart: (child) => {
      liveChild = child;
    },
  }).then((result) => {
    liveChild = null;
    return result;
  });

/** One git call. */
const runGit = (argv, { cwd, timeout } = {}) =>
  run("git", argv, { cwd, timeoutMs: timeout ?? STEP_TIMINGS.gitMs });

/**
 * The commits the run will read, pinned before anything reads them.
 *
 * A tip resolved once and then checked for presence: the report is given the
 * sha rather than the branch name, so a push landing mid-run cannot move what
 * the row describes.
 */
const resolveBranches = async (directory) => {
  const pinned = {};
  for (const branch of OBSERVED_BRANCHES) {
    const tip = await runGit(branchTipArgv(branch), { cwd: directory });
    // A call ended at its own deadline is a timeout, and saying
    // `release_branch_unavailable` instead would send an operator to look at
    // the repository's branches for something that was a hung process.
    if (tip.timedOut) {
      return { stage: "timeout", detail: `reading ${branch}'s tip passed its deadline` };
    }
    const read = readBranchTip(branch, tip.status === 0 ? tip.stdout : "");
    if (read.problem) {
      return { stage: "release_branch_unavailable", detail: read.problem };
    }
    const present = await runGit(commitPresentArgv(read.sha), { cwd: directory });
    if (present.timedOut) {
      return { stage: "timeout", detail: `checking ${branch}'s tip passed its deadline` };
    }
    if (present.status !== 0) {
      // A tip the clone names but does not have is the partial clone having
      // fetched less than it said. The report would fail on it later with a
      // stage that points at the report instead of at the clone.
      return {
        stage: "release_branch_unavailable",
        detail: `${branch} tip is not a commit in the clone`,
      };
    }
    pinned[branch] = read.sha;
  }
  return { pinned };
};

/**
 * Every open issue, or the stage the read failed at.
 *
 * Paged to the structural ceiling rather than to exhaustion: a paging bug that
 * never saw a short page would otherwise walk the API all night, and the
 * ceiling turns that into a named failure for one slot.
 */
const readIssues = async (token) => {
  let held = [];
  let bytes = 0;
  let received = 0;
  for (let page = 1; page <= ISSUE_FETCH_MAX_REQUESTS; page += 1) {
    let response;
    try {
      response = await fetch(issuesUrl(OBSERVED_REPOSITORY, page), {
        headers: issuesHeaders(token),
        signal: AbortSignal.timeout(STEP_TIMINGS.issueFetchMs),
      });
    } catch {
      // The reason is not reported: a fetch failure's message can carry the
      // request, and the request carries the token's header.
      return { stage: "issue_fetch_failed", detail: `page ${page} could not be fetched` };
    }
    if (!response.ok) {
      // The status is a fact about the API, not about the token's value.
      return { stage: "issue_fetch_failed", detail: `page ${page} answered ${response.status}` };
    }

    const body = await readLimitedBody(response, ISSUE_RECEIVED_MAX_BYTES - received);
    if (body.tooLarge !== undefined) {
      return {
        stage: "issue_input_too_large",
        detail: `page ${page} passed the ${ISSUE_RECEIVED_MAX_BYTES}-byte receive limit`,
      };
    }
    if (body.problem) return { stage: "issue_fetch_failed", detail: `page ${page}: ${body.problem}` };
    const allowance = admitReceivedBytes(received, body.bytes);
    if (allowance.stage) return allowance;
    received = allowance.received;

    let parsed;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return { stage: "issue_fetch_failed", detail: `page ${page} was not JSON` };
    }
    const admitted = admitIssuePage(parsed, held, { bytes });
    if (admitted.stage) return admitted;
    held = admitted.issues;
    bytes = admitted.bytes;
    if (admitted.done) return { issues: held };
  }
  // The ceiling reached with a full page every time: there is more backlog than
  // this run is allowed to read, and a partial read is a wrong observation.
  return { stage: "issue_fetch_failed", detail: `${ISSUE_FETCH_MAX_REQUESTS} pages were not enough` };
};

/**
 * What the run observed for its slot, as the submission's shape.
 *
 * Every return is either a payload with the two commits it read or a single
 * failure stage. There is no third answer: a run that got part of the way
 * carries nothing, because a row that holds half an observation is worse than a
 * row that says the slot failed.
 */
const observe = async (config) => {
  const directory = mkdtempSync(join(tmpdir(), "product-research-"));
  try {
    const clone = await runGit(cloneArgv(OBSERVED_REPOSITORY, directory), {
      timeout: STEP_TIMINGS.cloneMs,
    });
    if (clone.status !== 0) {
      // The stage only. `git clone` prints the remote s message on failure, and a
      // deploy log is read by whoever opens it.
      const stage = childFailureStage(clone, "clone_failed");
      say(`${stage}: the clone did not complete`);
      return { failureStage: stage };
    }

    const branches = await resolveBranches(directory);
    if (branches.stage) {
      say(`${branches.stage}: ${branches.detail}`);
      return { failureStage: branches.stage };
    }

    const issues = await readIssues(config.githubToken);
    if (issues.stage) {
      say(`${issues.stage}: ${issues.detail}`);
      return { failureStage: issues.stage };
    }
    say(`${issues.issues.length} open issues read`);

    // Written to a file rather than piped: the report reads its issues from a
    // path, and a pipe would put the list in the child's argv where a process
    // listing can read it.
    const issuesFile = join(directory, "open-issues.json");
    writeFileSync(issuesFile, JSON.stringify(issues.issues), "utf8");

    const child = await run(
      process.execPath,
      reportArgv({
        cli: fileURLToPath(new URL("../report-issue-backlog.mjs", import.meta.url)),
        repository: directory,
        issuesFile,
        develop: branches.pinned.develop,
        main: branches.pinned.main,
      }),
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        timeoutMs: STEP_TIMINGS.reportMs,
        maxBytes: REPORT_MAX_BUFFER_BYTES,
      },
    );
    const read = readReport(child);
    if (read.stage) {
      say(`${childFailureStage(child, read.stage)}: ${read.detail}`);
      return { failureStage: childFailureStage(child, read.stage) };
    }

    const built = buildObservationPayload(read.report);
    if (built.failure) {
      say(`${built.failure.stage}: ${built.failure.problem}`);
      return { failureStage: built.failure.stage };
    }

    return {
      payload: built.payload,
      developSha: branches.pinned.develop,
      mainSha: branches.pinned.main,
    };
  } finally {
    // The clone is temporary whatever happened. A run that left it behind would
    // fill the container's disk one slot at a time.
    rmSync(directory, { recursive: true, force: true });
  }
};

/**
 * The run's one write, and the only thing it ever sends anywhere.
 *
 * Aborted at its own deadline rather than left to the watchdog: the watchdog
 * ends the process, and a request cut off mid-flight is the one case where the
 * run cannot know whether its row exists.
 */
const submit = async (config, body) => {
  let response;
  try {
    response = await fetch(config.ingestUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.ingestSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_RUN_TIMINGS.submitAbortMs),
    });
  } catch {
    // Not reported in detail and never retried: the request may have reached
    // the route, and a second attempt is how one slot gets two answers.
    return { problem: "the submission did not complete" };
  }
  let answer;
  try {
    answer = await response.json();
  } catch {
    answer = null;
  }
  if (!response.ok) {
    // The route's refusal code, which names what it refused. Safe to print:
    // it is a fixed vocabulary and carries nothing the caller sent.
    return { problem: `the route answered ${response.status} ${answer?.refused ?? "with no code"}` };
  }
  return { recorded: answer };
};

const main = async () => {
  const timingProblems = runTimingProblems();
  if (timingProblems.length > 0) {
    // A contradiction between the deadlines is a mistake in the checked-in
    // defaults, not something the environment can cause. Refuse before doing
    // any work with deadlines that do not hold.
    for (const problem of timingProblems) say(`timing: ${problem}`);
    return 1;
  }

  if (PROBE) {
    // The probe cannot use `planRun()` -- that planner requires the
    // submission URL and secret the probe must not have -- but the check
    // those share is the one that says a product database credential cannot
    // be in this project, and skipping it would leave one service here
    // unchecked.
    const plan = planProbe(process.env, {
      systemNames: systemNamesForPlatform(process.platform),
    });
    if (plan.mode === "config") {
      for (const problem of plan.problems) say(`config: ${problem}`);
      return 1;
    }
    return await probeImage();
  }

  const plan = planRun(process.env, {
    systemNames: systemNamesForPlatform(process.platform),
  });

  if (plan.mode === "dark") {
    // Not a failure. The service exists and is not meant to do anything, so it
    // clones nothing, reads nothing and submits nothing.
    say("switch unset; nothing to do");
    return 0;
  }

  if (plan.mode === "config") {
    for (const problem of plan.problems) say(`config: ${problem}`);
    return 1;
  }

  // Read once, before the deadlines below capture it: both of them answer for
  // this slot, and a second clock read could straddle a boundary.
  const slot = slotForInstant(Date.now());
  say(`answering for slot ${slot}`);

  const state = createRunState();
  let hardTimer;
  let prepareTimer;

  const finish = (code) => {
    if (!state.finish(code)) return;
    // Cleared here rather than in a timer: a live timer keeps the process alive
    // past its own work, and the hard one would then end a finished run with
    // exit 1.
    clearTimeout(hardTimer);
    clearTimeout(prepareTimer);
    process.exitCode = code;
  };

  hardTimer = setTimeout(() => {
    // `watchdogAction` ends the run as it answers, so nothing after this can
    // begin a submission -- a request started past the deadline is cut off
    // mid-flight, and that is the one case where the run cannot know whether
    // its row exists.
    if (state.watchdogAction("hard") !== "exit") return;
    say("hard deadline reached; ending the run");
    clearTimeout(hardTimer);
    clearTimeout(prepareTimer);
    // Whatever is still running goes with the process. `process.exit` does not
    // wait for a child and does not end one: without this the container would
    // keep the clone alive after the run that started it had gone.
    endChild(liveChild, "SIGKILL");
    process.exitCode = state.exitCode ?? 1;
    // Nothing in flight can be waited for: whatever the run was doing, its
    // outcome is unknown and a second answer for this slot is worse than none.
    process.exit(process.exitCode);
  }, DEFAULT_RUN_TIMINGS.hardMs);
  prepareTimer = setTimeout(() => {
    if (state.watchdogAction("prepare") !== "submit-timeout") return;
    say("preparation deadline reached");
    // It takes the one submission permission, so the observation below cannot
    // also answer for this slot -- and it has to answer for it, because a slot
    // with no row is indistinguishable from a slot nobody ran. `timeout` is
    // what that row says.
    //
    // The work still running is ended first. It cannot contribute to this
    // answer any more, and a clone left running would outlive the submission.
    endChild(liveChild, "SIGKILL");
    void submit(plan.config, submissionBody({
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      slot,
      failureStage: "timeout",
    })).then((sent) => {
      const prepared = sent.problem
        ? { problem: sent.problem }
        : readSubmissionReceipt(sent.recorded, { slot, outcome: "failed" });
      if (prepared.problem) say(`submission: ${prepared.problem}`);
      else say(`recorded ${sent.recorded?.observationId ?? "a row"}: failed at timeout`);
      finish(1);
      // And then the process goes, rather than being left to drain. `finish`
      // clears the hard deadline, so after this there is nothing left that
      // could end a run something is still holding open -- and a run that does
      // not end is one Railway skips every later slot behind.
      process.exit(process.exitCode ?? 1);
    });
  }, DEFAULT_RUN_TIMINGS.prepareMs);


  let outcome;
  try {
    outcome = await observe(plan.config);
  } catch (error) {
    // Every failure the run can name has a stage and is submitted, so this is
    // only what no stage covers. There is no stage for "the runner itself
    // broke" and inventing one would store a claim about the backlog that no
    // run made; the slot stays silent instead, and the silence check is what
    // reports it. The name only -- an error's message can carry the request.
    say(`the run could not finish: ${error?.name ?? "an error"}`);
    finish(1);
    return process.exitCode ?? 1;
  }

  // One permission, taken once. If the preparation deadline fired while the
  // observation was still running it already took it, and this run must not
  // send a second answer for the same slot.
  if (!state.beginSubmit()) {
    say("the deadline answered for this slot; not submitting");
    return state.exitCode ?? 1;
  }

  const sent = await submit(
    plan.config,
    submissionBody({ schemaVersion: OBSERVATION_SCHEMA_VERSION, slot, ...outcome }),
  );
  if (sent.problem) {
    say(`submission: ${sent.problem}`);
    finish(1);
    return process.exitCode ?? 1;
  }

  // A 2xx is not a receipt. The route answers with the row it wrote and the
  // digest it computed from what it stored, for exactly this comparison.
  const receipt = readSubmissionReceipt(sent.recorded, {
    slot,
    outcome: outcome.failureStage ? "failed" : "ok",
    ...(outcome.failureStage
      ? {}
      : { payloadDigest: observationPayloadDigest(outcome.payload) }),
  });
  if (receipt.problem) {
    // Not retried and not repaired: the row exists, and a second answer for
    // one slot is worse than none. The point is that somebody finds out.
    say(`the recorded row does not match what was sent: ${receipt.problem}`);
    finish(1);
    return process.exitCode ?? 1;
  }

  if (outcome.failureStage) {
    // The row exists and says the slot failed. The run exits non-zero so the
    // deploy log says so too -- the restart policy is NEVER, so this is a
    // report, not a retry.
    say(`recorded ${sent.recorded?.observationId ?? "a row"}: failed at ${outcome.failureStage}`);
    finish(1);
    return process.exitCode ?? 1;
  }

  say(`recorded ${sent.recorded?.observationId ?? "a row"}: ${outcome.payload.issues.length} issues`);
  finish(0);
  return process.exitCode ?? 0;
};

process.exitCode = await main();
