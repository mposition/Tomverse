/**
 * Classifies a failed CI job for the QA-release digest.
 *
 * docs/policy/qa-release-agent.md, section 1: these are digest enum values,
 * not GitHub labels, and a classification is not a judgement. The rules are
 * deterministic and read only structured fields (job conclusion, step names
 * and conclusions, JSON reporter outcomes). Log text is never parsed. When no
 * rule has evidence the answer is `undetermined`, which creates no work for
 * the owner.
 *
 * Pure.
 */
import type { QaReleaseDigest } from "./qaReleaseDigestSchemaCore.ts";

export type QaReleaseCiClass = QaReleaseDigest["ci"][number]["label"];

/** History needed before the history-based classes apply. Policy: the last 10 runs. */
export const QA_RELEASE_CI_HISTORY_RUNS = 10;

/**
 * Steps that prepare or tidy up a run rather than test the product. A failure
 * here is infrastructure. Building the app is deliberately not on the list: a
 * build that fails is usually the change, not the runner.
 */
const NON_TEST_STEP = /^(checkout|set ?up |restore |install (dependencies|chromium|playwright|browsers)|upload |download |post |cache )/i;

export type QaReleaseCiStep = { name: string; conclusion: string | null };

export type QaReleaseFailingTest = {
  /** The JSON reporter recorded a failure and then a passing retry in this run. */
  retriedThenPassed: boolean;
  /** This test's outcomes in earlier runs from JSON reporter artifacts, newest first. */
  recentOutcomes: readonly ("pass" | "fail")[];
};

export type QaReleaseCiClassifyInput = {
  jobConclusion: string;
  steps: readonly QaReleaseCiStep[];
  /**
   * The failing tests from this run's JSON reporter, or `null` when the suite
   * has no JSON reporter or its artifact could not be read.
   */
  failingTests: readonly QaReleaseFailingTest[] | null;
};

/** Job conclusions GitHub reports when the runner, not the product, ended the job. */
const INFRA_CONCLUSIONS = new Set(["cancelled", "timed_out", "startup_failure"]);

/**
 * One failing test's class. A passing retry is checked first: a test that
 * failed last run but passed on retry now is flaky evidence, not a
 * reproduction.
 */
function classifyTest(test: QaReleaseFailingTest): QaReleaseCiClass {
  if (test.retriedThenPassed) return "flaky_suspected";
  if (test.recentOutcomes.length < QA_RELEASE_CI_HISTORY_RUNS) return "undetermined";
  const window = test.recentOutcomes.slice(0, QA_RELEASE_CI_HISTORY_RUNS);
  // Failed this run (it is in the failing list) and the run before it.
  if (window[0] === "fail") return "consecutive_repro";
  if (window.includes("pass") && window.includes("fail")) return "flaky_suspected";
  return "undetermined";
}

export function classifyQaReleaseCiFailure(input: QaReleaseCiClassifyInput): QaReleaseCiClass {
  if (INFRA_CONCLUSIONS.has(input.jobConclusion)) return "infra";

  const firstFailed = input.steps.find((step) => step.conclusion === "failure");
  if (firstFailed && NON_TEST_STEP.test(firstFailed.name.trim())) return "infra";

  const tests = input.failingTests;
  if (tests === null || tests.length === 0) return "undetermined";

  // One label describes the whole job, so it is given only when every failing
  // test has the same evidence. One test without an explanation, or tests
  // that disagree, leave the job undetermined -- another test's retry must
  // never relabel an unexplained failure.
  const classes = new Set(tests.map(classifyTest));
  return classes.size === 1 ? [...classes][0] : "undetermined";
}
