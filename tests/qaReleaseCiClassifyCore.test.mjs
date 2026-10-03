import assert from "node:assert/strict";
import test from "node:test";

import { QA_RELEASE_CI_HISTORY_RUNS, classifyQaReleaseCiFailure } from "../lib/qaReleaseCiClassifyCore.ts";

const steps = (failedName) =>
  [
    "Checkout",
    "Setup Node.js",
    "Install dependencies",
    "Build once for the Chromium test server",
    "Install Chromium",
    "Run Chromium desktop and mobile E2E tests",
    "Upload failed test evidence",
  ].map((name) => ({ name, conclusion: name === failedName ? "failure" : "success" }));

const classify = (overrides) =>
  classifyQaReleaseCiFailure({
    jobConclusion: "failure",
    steps: steps("Run Chromium desktop and mobile E2E tests"),
    failingTests: null,
    ...overrides,
  });

const history = (...outcomes) => [...outcomes, ...Array(QA_RELEASE_CI_HISTORY_RUNS).fill("pass")].slice(0, QA_RELEASE_CI_HISTORY_RUNS);

test("a cancelled or timed-out job is infra", () => {
  assert.equal(classify({ jobConclusion: "cancelled" }), "infra");
  assert.equal(classify({ jobConclusion: "timed_out" }), "infra");
});

test("a failure in a preparing step is infra", () => {
  for (const name of ["Checkout", "Setup Node.js", "Install dependencies", "Install Chromium", "Upload failed test evidence"]) {
    assert.equal(classify({ steps: steps(name) }), "infra", name);
  }
});

test("a failed build or test step without evidence is undetermined", () => {
  assert.equal(classify({ steps: steps("Build once for the Chromium test server") }), "undetermined");
  assert.equal(classify({}), "undetermined");
  assert.equal(classify({ failingTests: [] }), "undetermined");
});

test("history-based classes need the full window of JSON history", () => {
  const short = { retriedThenPassed: false, recentOutcomes: ["fail", "pass"] };
  assert.equal(classify({ failingTests: [short] }), "undetermined");
});

test("failing this run and the previous run is a consecutive reproduction", () => {
  assert.equal(
    classify({ failingTests: [{ retriedThenPassed: false, recentOutcomes: history("fail") }] }),
    "consecutive_repro",
  );
});

test("a passing retry, or mixed results in the window, is suspected flaky", () => {
  assert.equal(classify({ failingTests: [{ retriedThenPassed: true, recentOutcomes: [] }] }), "flaky_suspected");
  assert.equal(
    classify({ failingTests: [{ retriedThenPassed: false, recentOutcomes: history("pass", "fail", "pass") }] }),
    "flaky_suspected",
  );
});

test("a consistently passing history with one new failure stays undetermined", () => {
  assert.equal(
    classify({ failingTests: [{ retriedThenPassed: false, recentOutcomes: history() }] }),
    "undetermined",
  );
});

test("infra wins over test evidence", () => {
  assert.equal(
    classify({ jobConclusion: "cancelled", failingTests: [{ retriedThenPassed: false, recentOutcomes: history("fail") }] }),
    "infra",
  );
});

test("a passing retry is flaky even when the previous run failed", () => {
  assert.equal(
    classify({ failingTests: [{ retriedThenPassed: true, recentOutcomes: history("fail") }] }),
    "flaky_suspected",
  );
});

test("one test's evidence never relabels another test's unexplained failure", () => {
  const unexplained = { retriedThenPassed: false, recentOutcomes: history() };
  for (const other of [
    { retriedThenPassed: true, recentOutcomes: [] },
    { retriedThenPassed: false, recentOutcomes: history("fail") },
  ]) {
    assert.equal(classify({ failingTests: [unexplained, other] }), "undetermined");
    assert.equal(classify({ failingTests: [other, unexplained] }), "undetermined");
  }
  // Tests that disagree with each other leave the job undetermined too.
  assert.equal(
    classify({
      failingTests: [
        { retriedThenPassed: false, recentOutcomes: history("fail") },
        { retriedThenPassed: true, recentOutcomes: [] },
      ],
    }),
    "undetermined",
  );
  // Agreement keeps the label.
  const repro = { retriedThenPassed: false, recentOutcomes: history("fail") };
  assert.equal(classify({ failingTests: [repro, repro] }), "consecutive_repro");
});

test("a job the runner never started is infra", () => {
  assert.equal(classify({ jobConclusion: "startup_failure", steps: [] }), "infra");
});
