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

import { spawnSync } from "node:child_process";
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
} from "../../lib/productResearchObservationCore.mjs";
import {
  ISSUE_FETCH_MAX_REQUESTS,
  OBSERVED_REPOSITORY,
  REPORT_MAX_BUFFER_BYTES,
  STEP_TIMINGS,
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
const probeImage = () => {
  const version = spawnSync("git", ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    // Not the whole environment. `git --version` has no reason to see the
    // service's token, and a child that inherits everything is a child that
    // can print anything.
    env: childEnvironment(process.env, { platform: process.platform }),
  });
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
 * One git call, with nothing of the service's environment it does not need.
 *
 * `childEnvironment()` is what keeps the submission secret and the read token
 * out of a child that has no use for them: git clones a public repository here,
 * and a child that inherits everything is a child that can print anything.
 */
const runGit = (argv, { cwd, timeout } = {}) =>
  spawnSync("git", argv, {
    cwd,
    encoding: "utf8",
    timeout: timeout ?? STEP_TIMINGS.gitMs,
    env: childEnvironment(process.env, { platform: process.platform }),
  });

/**
 * The commits the run will read, pinned before anything reads them.
 *
 * A tip resolved once and then checked for presence: the report is given the
 * sha rather than the branch name, so a push landing mid-run cannot move what
 * the row describes.
 */
const resolveBranches = (directory) => {
  const pinned = {};
  for (const branch of OBSERVED_BRANCHES) {
    const tip = runGit(branchTipArgv(branch), { cwd: directory });
    const read = readBranchTip(branch, tip.status === 0 ? tip.stdout : "");
    if (read.problem) {
      return { stage: "release_branch_unavailable", detail: read.problem };
    }
    const present = runGit(commitPresentArgv(read.sha), { cwd: directory });
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
    let parsed;
    try {
      parsed = await response.json();
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
    const clone = runGit(cloneArgv(OBSERVED_REPOSITORY, directory), {
      timeout: STEP_TIMINGS.cloneMs,
    });
    if (clone.status !== 0) {
      // The stage only. `git clone` prints the remote s message on failure, and a
      // deploy log is read by whoever opens it.
      const stage = childFailureStage(clone, "clone_failed");
      say(`${stage}: the clone did not complete`);
      return { failureStage: stage };
    }

    const branches = resolveBranches(directory);
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

    const child = spawnSync(
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
        encoding: "utf8",
        timeout: STEP_TIMINGS.reportMs,
        maxBuffer: REPORT_MAX_BUFFER_BYTES,
        env: childEnvironment(process.env, { platform: process.platform }),
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
    return probeImage();
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
    process.exitCode = state.exitCode ?? 1;
    // Nothing in flight can be waited for: whatever the run was doing, its
    // outcome is unknown and a second answer for this slot is worse than none.
    process.exit(process.exitCode);
  }, DEFAULT_RUN_TIMINGS.hardMs);
  prepareTimer = setTimeout(() => {
    if (state.watchdogAction("prepare") !== "submit-timeout") return;
    say("preparation deadline reached");
    // The timeout envelope is the next slice's work; until it exists the run
    // ends rather than reporting a success it did not have.
    finish(1);
  }, DEFAULT_RUN_TIMINGS.prepareMs);

  const slot = slotForInstant(Date.now());
  say(`answering for slot ${slot}`);

  const outcome = await observe(plan.config);

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
