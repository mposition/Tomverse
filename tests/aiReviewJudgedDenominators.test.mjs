// The pre-threshold path: denominators with no score in them.
//
// §3.6 of the transition decision fixes the order -- thresholds chosen from
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

import {
  AI_REVIEW_SCORING_CONTRACT_VERSION,
  judgedSourceCaseDigest,
} from "../lib/aiReviewEvalJudgement.ts";
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
  ...(phenomenon === "prompt_injection" ? { injectionMarkers: ["ignore previous"] } : {}),
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

/**
 * Judged cases: gold and registration only, which is the whole point.
 *
 * The digest is computed from the dataset case this gold is about, because the
 * command now checks it -- a fixture carrying a placeholder would be refused,
 * which is the behaviour the refusal tests rely on.
 */
const writeJudgedCases = (root, entries) => {
  const dataset = JSON.parse(readFileSync(join(root, "dataset.json"), "utf8"));
  const byId = new Map(dataset.cases.map((item) => [item.id, item]));
  const directory = join(root, "cases");
  mkdirSync(directory, { recursive: true });
  for (const [id, goldItems] of entries) {
    const caseDirectory = join(directory, id);
    mkdirSync(caseDirectory, { recursive: true });
    const source = byId.get(id);
    writeFileSync(
      join(caseDirectory, "case.json"),
      `${JSON.stringify(
        {
          caseId: id,
          contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
          sourceCaseDigest: source
            ? judgedSourceCaseDigest(source)
            : `sha256:${"0".repeat(64)}`,
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

test("denominators come from the frozen set, and the unverifiable part is a range", () => {
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

    // With no judged gold read, the missed-everything denominator is 0-3: the
    // three non-negative cases may or may not plant something under their
    // judged gold, and the dataset's keyword gold does not say.
    assert.match(out, /전체 \(4건\)\s+0–3\s+4\s+1/);
    assert.match(out, /언어 ko \(3\)\s+0–2\s+3\s+1/);
    assert.match(out, /언어 en \(1\)\s+0–1\s+1\s+0/);
    assert.match(out, /0\/4건 검증됨 — 미보고율 분모는 \*\*구간\*\*이다/);

    // No numerator, no rate, no observed Wilson interval anywhere.
    assert.doesNotMatch(out, /= 0\.\d{3}/);
    assert.doesNotMatch(out, /Wilson \[/);
    assert.match(out, /관측값은 하나도 쓰이지 않았다/);
  });
});

test("a judged gold item on a case the dataset gold leaves empty is not below any bound", () => {
  withFiles((root) => {
    // The reproduction: a prompt_injection case carries no keyword gold, and
    // its judged gold plants one item. Treating the dataset's gold as a bound
    // reported 0 where the real denominator is 1.
    writeDataset(root, [
      datasetCase({ id: "p1", phenomenon: "prompt_injection", goldItems: 0 }),
    ]);
    const bounded = report(root);
    assert.equal(bounded.status, 0, bounded.stderr);
    // Non-negative and unverified, so it widens the range rather than being
    // assumed absent.
    assert.match(bounded.stdout, /전체 \(1건\)\s+0–1\s+1\s+0/);

    const cases = writeJudgedCases(root, [["p1", 1]]);
    const exact = report(root, [`--cases=${cases}`]);
    assert.equal(exact.status, 0, exact.stderr);
    assert.match(exact.stdout, /1건 전부 검증됨 — 미보고율 분모가 정확하다/);
    assert.match(exact.stdout, /전체 \(1건\)\s+1\s+1\s+0/);
  });
});

test("verified judged gold makes the denominator exact, in either direction", () => {
  withFiles((root) => {
    writeDataset(root, [datasetCase({ id: "e1" }), datasetCase({ id: "e2" })]);
    assert.match(report(root).stdout, /전체 \(2건\)\s+0–2/);

    // e1 plants, e2 does not: exact and lower than the dataset gold suggests.
    const cases = writeJudgedCases(root, [
      ["e1", 1],
      ["e2", 0],
    ]);
    const exact = report(root, [`--cases=${cases}`]);
    assert.equal(exact.status, 0, exact.stderr);
    assert.match(exact.stdout, /2건 전부 검증됨 — 미보고율 분모가 정확하다/);
    assert.match(exact.stdout, /전체 \(2건\)\s+1\s+2\s+0/);
    assert.doesNotMatch(exact.stdout, /구간/);
  });
});

test("allowed failures follow the range rather than picking an end", () => {
  withFiles((root) => {
    // 40 planted cases, none verified: the denominator is 0-40, so at a 0.10
    // ceiling the allowed failures run from "impossible" to some positive
    // number. One figure would be a claim the input does not support.
    writeDataset(
      root,
      Array.from({ length: 40 }, (unused, index) => datasetCase({ id: `h${index}` }))
    );
    const result = report(root);
    assert.equal(result.status, 0, result.stderr);
    const line = /^ {2}미보고율 전체\s+0–40\s+(.*)$/m.exec(result.stdout);
    assert.ok(line, result.stdout);
    // At the loosest ceiling the low end is still "—" (a zero denominator can
    // satisfy nothing) and the high end is a number, so every cell is a range.
    assert.ok(
      line[1].includes("—–"),
      `expected ranged cells, got: ${line[1]}`
    );
  });
});

// ---------------------------------------------------------------------------
// A judged case has to earn the word "exact"
// ---------------------------------------------------------------------------

test("an unverifiable judged case is refused rather than counted", async (t) => {
  const refusals = [
    [
      "an old contract version",
      (root) => {
        const directory = writeJudgedCases(root, [["k1", 1]]);
        const path = join(directory, "k1", "case.json");
        const judged = JSON.parse(readFileSync(path, "utf8"));
        writeFileSync(
          path,
          `${JSON.stringify({ ...judged, contractVersion: "ai-review-scoring-judged-v2" }, null, 2)}\n`,
          "utf8"
        );
        return directory;
      },
      /written for ai-review-scoring-judged-v2/,
    ],
    [
      "a file with nothing but an id",
      (root) => {
        const directory = join(root, "cases");
        mkdirSync(join(directory, "k1"), { recursive: true });
        writeFileSync(
          join(directory, "k1", "case.json"),
          `${JSON.stringify({ caseId: "k1" })}\n`,
          "utf8"
        );
        return directory;
      },
      /contractVersion|sourceCaseDigest|responseLabels/,
    ],
    [
      "a different question or answers",
      (root) => {
        const directory = writeJudgedCases(root, [["k1", 1]]);
        const path = join(directory, "k1", "case.json");
        const judged = JSON.parse(readFileSync(path, "utf8"));
        writeFileSync(
          path,
          `${JSON.stringify({ ...judged, sourceCaseDigest: `sha256:${"0".repeat(64)}` }, null, 2)}\n`,
          "utf8"
        );
        return directory;
      },
      /made from sha256:0{64} and the frozen set's case is/,
    ],
    [
      "a case the frozen set does not hold",
      (root) => writeJudgedCases(root, [["k1", 1], ["k9", 1]]),
      /k9: the frozen set holds no such case/,
    ],
    [
      "the same id twice",
      (root) => {
        const directory = writeJudgedCases(root, [["k1", 1]]);
        // A second directory whose file names the same case.
        mkdirSync(join(directory, "k1-copy"), { recursive: true });
        writeFileSync(
          join(directory, "k1-copy", "case.json"),
          readFileSync(join(directory, "k1", "case.json"), "utf8"),
          "utf8"
        );
        return directory;
      },
      /k1: judged twice in this directory/,
    ],
    [
      "a gold naming an answer the case never declared",
      (root) => {
        const directory = writeJudgedCases(root, [["k1", 1]]);
        const path = join(directory, "k1", "case.json");
        const judged = JSON.parse(readFileSync(path, "utf8"));
        judged.gold.missingPoints = [{ requirementId: "deadline", targetLabel: "z" }];
        writeFileSync(path, `${JSON.stringify(judged, null, 2)}\n`, "utf8");
        return directory;
      },
      /k1: /,
    ],
  ];

  for (const [name, prepare, expected] of refusals) {
    await t.test(name, () => {
      withFiles((root) => {
        writeDataset(root, [datasetCase({ id: "k1" })]);
        const directory = prepare(root);
        const result = report(root, [`--cases=${directory}`]);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /cannot be read as gold for this sample/);
        assert.match(result.stdout, expected);
        // And no denominator at all: silently dropping to a range would hide
        // that exactness was asked for with unusable files.
        assert.doesNotMatch(result.stdout, /=== 1\. 분모 ===/);
        assert.doesNotMatch(result.stdout, /검증됨/);
      });
    });
  }
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
