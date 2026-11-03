import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildJudgedGateRun } from "./fixtures/aiReviewJudgedGate.mjs";
import { evaluateAiReviewJudgedGate } from "../lib/aiReviewJudgedGate.ts";
import { readAiReviewJudgedRunReport } from "../lib/aiReviewJudgedRunReport.ts";

test("the judged gate verifies the full file flow and never falls back to old ceilings", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "judged-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = buildJudgedGateRun(root);
  assert.deepEqual(fixture.evidence.problems, []);
  const report = readAiReviewJudgedRunReport(fixture.paths);
  assert.equal(report.result.aggregable, true, JSON.stringify(report.result));
  const check = (over = {}) =>
    evaluateAiReviewJudgedGate({
      thresholds: fixture.thresholds,
      report,
      evidence: fixture.evidence,
      ...over,
    });
  assert.equal(check().passed, true, JSON.stringify(check()));
  await t.test(
    "missing judgement, unsigned bar and zero denominator each refuse",
    () => {
      assert.equal(
        check({ thresholds: { ...fixture.thresholds, approvedBy: null } })
          .passed,
        false,
      );
      assert.equal(
        check({
          report: {
            ...report,
            result: { aggregable: false, blockers: ["unjudged"] },
          },
        }).passed,
        false,
      );
      const zero = structuredClone(report);
      zero.result.metrics.missedEveryPlantedIssueRate.wilsonUpper = null;
      assert.match(
        check({ report: zero }).problems.join("\n"),
        /insufficient_evidence/,
      );
    },
  );
  await t.test("judged failure beats perfect keyword error rates", () => {
    const changed = structuredClone(report);
    changed.result.metrics.inventedFindingRate.wilsonUpper = 0.6;
    assert.match(
      check({ report: changed }).problems.join("\n"),
      /inventedFindingRate.*exceeds/,
    );
  });
  await t.test(
    "arm gaps, missing arms and negative subset ceilings are applied",
    () => {
      const changed = structuredClone(report);
      changed.result.byLanguage[0].metrics.inventedFindingRate.wilsonUpper = 0.6;
      assert.match(
        check({ report: changed }).problems.join("\n"),
        /language gap/,
      );
      changed.result.byTaskType.pop();
      assert.match(
        check({ report: changed }).problems.join("\n"),
        /no arm for/,
      );
      assert.match(
        check({
          thresholds: {
            ...fixture.thresholds,
            negativeSubset: { policy: "gate", maxWilsonUpper: 0.2 },
          },
        }).problems.join("\n"),
        /negative subset: insufficient_evidence/,
      );
    },
  );
  const invoke = () =>
    spawnSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        "scripts/check-ai-review-eval-dataset.mjs",
        `--register=${fixture.registerPath}`,
        `--dataset-dir=${fixture.setDirectory}`,
        `--artifact=${fixture.paths.run}`,
        `--judged-thresholds=${fixture.thresholdPath}`,
        `--judgements=${fixture.paths.judgements}`,
      ],
      { encoding: "utf8" },
    );
  await t.test(
    "real gate CLI checks both evidence paths and is read only",
    () => {
      const before = readFileSync(fixture.paths.run);
      const result = invoke();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /judged-v3: six existing floors/);
      assert.deepEqual(readFileSync(fixture.paths.run), before);
    },
  );
  await t.test(
    "null and false threshold files are not treated as absent",
    () => {
      for (const value of [null, false]) {
        writeFileSync(fixture.thresholdPath, JSON.stringify(value));
        const result = invoke();
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.doesNotMatch(result.stdout, /All checks passed/);
      }
    },
  );
  await t.test(
    "a legacy version is not relabelled as a judged threshold set",
    () => {
      writeFileSync(
        fixture.thresholdPath,
        JSON.stringify({ ...fixture.thresholds, version: "v1-draft" }),
      );
      const result = invoke();
      assert.equal(result.status, 1);
      assert.match(result.stdout, /legacy threshold version cannot be reused/);
    },
  );
  await t.test(
    "unreadable judgement inputs produce an evidence failure rather than a crash",
    () => {
      writeFileSync(fixture.thresholdPath, JSON.stringify(fixture.thresholds));
      rmSync(fixture.paths.judgements, { recursive: true });
      const result = invoke();
      assert.equal(result.status, 1);
      assert.match(
        result.stdout,
        /insufficient_evidence: the judged run cannot be read/,
      );
      assert.doesNotMatch(result.stderr, /Unhandled|at readAiReview/);
    },
  );
});
