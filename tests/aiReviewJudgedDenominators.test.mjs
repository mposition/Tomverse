// The pre-threshold path: denominators with no score in them.
//
// .github/audits/ai-review-judged-gate-transition-decision-2026-09-10.md §3.6
// fixes the order -- thresholds chosen from
// sample composition, then the run. `report:ai-review-judged-run` cannot serve
// that order, because printing the scores is what it is for. This command is
// the other half, and the requirement that matters about it is negative: it
// must not be able to read a reviewer's output, a judgement record or a score.
//
// A negative requirement cannot be exercised by an input, so the first test is
// static. The rest check that the denominators it prints are the ones a
// complete run would have.
//
// Everything here is synthetic. No provider is called.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AI_REVIEW_SCORING_CONTRACT_VERSION } from "../lib/aiReviewEvalJudgement.ts";
import { datasetDigest } from "../lib/aiReviewEvalRun.ts";

const AT = "2026-09-10T00:00:00.000Z";

const datasetCase = ({
  id,
  language = "ko",
  taskType = "safety_sensitive",
  phenomenon = "omission",
  goldItems = 1,
}) => ({
  id,
  language,
  taskType,
  phenomenon,
  mode: "balanced",
  question: `[TEST] ${id}`,
  responses: ["a", "b", "c"].map((label) => ({
    label,
    modelId: "test",
    provider: "test",
    content: `answer ${label}`,
  })),
  gold:
    goldItems > 0
      ? {
          missingPoints: Array.from({ length: goldItems }, (unused, index) => ({
            id: `g${index}`,
            anyOf: ["deadline"],
            description: "the deadline",
          })),
        }
      : {},
  goldCompleteness: goldItems > 0 ? { missingPoints: true } : {},
  status: "adopted",
  adoptedBy: "TEST",
  adoptedAt: AT,
});

const frozen = (cases) => ({
  version: "test-v1",
  schemaVersion: 1,
  purpose: "decision",
  frozenAt: AT,
  frozenBy: "TEST",
  frozenDigest: datasetDigest({ cases }),
  cases,
});

const withFiles = (body) => {
  const root = mkdtempSync(join(tmpdir(), "ai-review denominators-"));
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const report = (root, extra = []) =>
  spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "scripts/report-ai-review-judged-denominators.mjs",
      `--dataset=${join(root, "dataset.json")}`,
      ...extra,
    ],
    { encoding: "utf8", env: process.env }
  );

const writeDataset = (root, cases) =>
  writeFileSync(join(root, "dataset.json"), `${JSON.stringify(frozen(cases), null, 2)}\n`, "utf8");

/** Judged cases: gold and registration only, which is the whole point. */
const writeJudgedCases = (root, entries) => {
  const directory = join(root, "cases");
  mkdirSync(directory, { recursive: true });
  for (const [id, goldItems] of entries) {
    const caseDirectory = join(directory, id);
    mkdirSync(caseDirectory, { recursive: true });
    writeFileSync(
      join(caseDirectory, "case.json"),
      `${JSON.stringify(
        {
          caseId: id,
          contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
          sourceCaseDigest: "sha256:0",
          responseLabels: ["a", "b", "c"],
          requirements: [{ id: "deadline", description: "the deadline" }],
          gold:
            goldItems > 0
              ? {
                  missingPoints: Array.from({ length: goldItems }, () => ({
                    requirementId: "deadline",
                    targetLabel: "c",
                  })),
                }
              : {},
          goldCompleteness: goldItems > 0 ? { missingPoints: true } : {},
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
  return directory;
};

// ---------------------------------------------------------------------------

test("the command has no means to read a score", () => {
  // Static, because no input can exercise it. A reordering of the output would
  // pass any behavioural test while still showing the scores.
  const source = readFileSync("scripts/report-ai-review-judged-denominators.mjs", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  for (const forbidden of ["record.json", "artifact.json", "observation.json"]) {
    assert.doesNotMatch(
      source,
      new RegExp(forbidden.replace(".", "\\.")),
      `the pre-threshold command must not read ${forbidden}`
    );
  }
  // Nor the modules that turn those files into numbers.
  assert.doesNotMatch(source, /aiReviewJudgedRunAggregate/);
  assert.doesNotMatch(source, /aggregateJudgedRun|judgedInventedFindings|scoreJudgedCase/);
  // And it writes nothing.
  assert.doesNotMatch(source, /writeFileSync|appendFileSync|rmSync|mkdirSync/);
});

test("denominators come from the frozen set alone", () => {
  withFiles((root) => {
    // 2 ko planted, 1 ko negative, 1 en planted.
    writeDataset(root, [
      datasetCase({ id: "d1" }),
      datasetCase({ id: "d2" }),
      datasetCase({ id: "d3", phenomenon: "no_issue", goldItems: 0 }),
      datasetCase({ id: "d4", language: "en" }),
    ]);
    const result = report(root);
    assert.equal(result.status, 0, result.stderr);
    const out = result.stdout;

    // missed-everything 3 (the three planted, non-negative), invented 4 (all),
    // negative subset 1.
    assert.match(out, /전체 \(4건\)\s+3\s+4\s+1/);
    assert.match(out, /언어 ko \(3\)\s+2\s+3\s+1/);
    assert.match(out, /언어 en \(1\)\s+1\s+1\s+0/);

    // No numerator, no rate, no observed Wilson interval anywhere.
    assert.doesNotMatch(out, /= 0\.\d{3}/);
    assert.doesNotMatch(out, /Wilson \[/);
    assert.match(out, /관측값은 하나도 쓰이지 않았다/);
  });
});

test("without the judged gold the missed-everything denominator is a bound, and says so", () => {
  withFiles((root) => {
    writeDataset(root, [datasetCase({ id: "e1" }), datasetCase({ id: "e2" })]);
    const bounded = report(root);
    assert.equal(bounded.status, 0, bounded.stderr);
    assert.match(bounded.stdout, /미보고율 분모는 \*\*상한\*\*이다/);

    // The judged gold is authored separately, so it can plant nothing where the
    // dataset's keyword gold has an item. Given the judged cases, the
    // denominator is exact -- and smaller.
    const cases = writeJudgedCases(root, [
      ["e1", 1],
      ["e2", 0],
    ]);
    const exact = report(root, [`--cases=${cases}`]);
    assert.equal(exact.status, 0, exact.stderr);
    assert.match(exact.stdout, /2건 전부 읽음 — 분모가 정확하다/);
    assert.match(exact.stdout, /전체 \(2건\)\s+1\s+2\s+0/);
    assert.doesNotMatch(exact.stdout, /미보고율 분모는 \*\*상한\*\*이다/);
  });
});

test("a zero denominator is named, not reported as a passing ceiling", () => {
  withFiles((root) => {
    // No negative case at all, which is `decision-v2`'s actual shape.
    writeDataset(root, [datasetCase({ id: "f1" }), datasetCase({ id: "f2" })]);
    const result = report(root);
    assert.equal(result.status, 0, result.stderr);
    // Every ceiling column on that row is "—": with a denominator of 0 nothing
    // can satisfy an upper bound.
    const line = /^ {2}음성 부분집합 전체\s+0\s+(.*)$/m.exec(result.stdout);
    assert.ok(line, result.stdout);
    assert.deepEqual(new Set(line[1].trim().split(/\s+/)), new Set(["—"]));
    assert.match(result.stdout, /분모 0은 0%가 아니다/);
  });
});

test("an unfrozen or drifted set yields no denominator at all", () => {
  withFiles((root) => {
    const cases = [datasetCase({ id: "g1" })];
    writeFileSync(
      join(root, "dataset.json"),
      `${JSON.stringify({ ...frozen(cases), frozenDigest: "sha256:wrong" }, null, 2)}\n`,
      "utf8"
    );
    const result = report(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cannot be read as a confirmed sample/);
    assert.match(result.stdout, /has changed since it was frozen/);
    assert.doesNotMatch(result.stdout, /=== 1\. 분모 ===/);
  });
});
