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
import process from "node:process";

import {
  DEFAULT_RUN_TIMINGS,
  createRunState,
  gitSupportsPartialClone,
  planRun,
  runTimingProblems,
  slotForInstant,
  systemNamesForPlatform,
} from "../../lib/productResearchObservationRunnerCore.mjs";

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

const main = () => {
  const timingProblems = runTimingProblems();
  if (timingProblems.length > 0) {
    // A contradiction between the deadlines is a mistake in the checked-in
    // defaults, not something the environment can cause. Refuse before doing
    // any work with deadlines that do not hold.
    for (const problem of timingProblems) say(`timing: ${problem}`);
    return 1;
  }

  if (PROBE) return probeImage();

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

  // The clone, the issue read, the report and the submission are the next
  // slice. Until they exist the planned run has nothing to do, and saying so is
  // better than exiting 0 as though a row had been written.
  say(`planned for slot ${slotForInstant(Date.now())}; no observation step built yet`);
  finish(1);
  return process.exitCode ?? 1;
};

process.exitCode = main();
