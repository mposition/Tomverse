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

export function classifyQaReleaseCiFailure(input: QaReleaseCiClassifyInput): QaReleaseCiClass {
  if (input.jobConclusion === "cancelled" || input.jobConclusion === "timed_out") return "infra";

  const firstFailed = input.steps.find((step) => step.conclusion === "failure");
  if (firstFailed && NON_TEST_STEP.test(firstFailed.name.trim())) return "infra";

  const tests = input.failingTests;
  if (tests === null || tests.length === 0) return "undetermined";

  const enoughHistory = (test: QaReleaseFailingTest) => test.recentOutcomes.length >= QA_RELEASE_CI_HISTORY_RUNS;

  // Failed this run and the run before it.
  if (tests.some((test) => enoughHistory(test) && test.recentOutcomes[0] === "fail")) {
    return "consecutive_repro";
  }
  // Passed on retry now, or both passed and failed within the window.
  if (
    tests.some(
      (test) =>
        test.retriedThenPassed ||
        (enoughHistory(test) &&
          test.recentOutcomes.slice(0, QA_RELEASE_CI_HISTORY_RUNS).includes("pass") &&
          test.recentOutcomes.slice(0, QA_RELEASE_CI_HISTORY_RUNS).includes("fail")),
    )
  ) {
    return "flaky_suspected";
  }
  return "undetermined";
}
