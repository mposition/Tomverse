// The file-reading caller of `aggregateJudgedRun()`.
//
// The core's own regressions build their inputs in memory, which shows the
// arithmetic and the refusals are right and cannot show that a caller reading
// files supplies the inputs the contract requires. Two of those requirements
// are about provenance and nothing else, so only a file-reading test can fail
// on them:
//
//   * the manifest digest must come from the stored run record, never from the
//     dataset being checked -- otherwise the comparison cannot fail;
//   * the plan must come from the run's record, never from the judgements that
//     happen to be on disk -- otherwise deleting a bundle shrinks the run
//     instead of blocking it.
//
// Everything here is synthetic: this file writes the dataset, the journal, the
// run artifact and the judgements. No provider is called, and the CLI is
// report-only, so the test also asserts that every input file is byte-identical
// afterwards.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { datasetDigest } from "../lib/aiReviewEvalRun.ts";
import {
  AI_REVIEW_SCORING_CONTRACT_VERSION,
  buildScoringArtifact,
  judgedSourceCaseDigest,
  observationRefFor,
} from "../lib/aiReviewEvalJudgement.ts";

const SIGNER = "TEST (not a person)";
const AT = "2026-09-09T00:00:00.000Z";
const REQ = "deadline";

/**
 * One case, as four files plus the rows a run would have recorded about it.
 *
 * `reports` false means the reviewer said nothing, which is what makes a case
 * land in the missed-everything numerator.
 */
const buildCase = ({ id, reports = true, phenomenon = "omission", invents = false }) => {
  const responses = [
    { label: "a", modelId: "test", provider: "test", content: `answer a of ${id}` },
    { label: "b", modelId: "test", provider: "test", content: `answer b of ${id}` },
    { label: "c", modelId: "test", provider: "test", content: `answer c of ${id}` },
  ];
  const question = `[TEST] ${id}`;
  const sourceCase = {
    id,
    question,
    responses: responses.map(({ label, content }) => ({ label, content })),
  };

  const missingPoints = reports ? [`[TEST] ${id}: c omits the deadline`] : [];
  const contradictions = invents ? [`[TEST] ${id}: a and b disagree about the fee`] : [];
  const findings = { contradictions, missingPoints, differences: [] };
  const allText = [...contradictions, ...missingPoints].join("\n");
  const observation = {
    findings,
    allText,
    reviewerProse: allText,
    totalQuotes: 0,
    matchedQuotes: 0,
    schemaValid: true,
  };

  const claims = [];
  if (reports) {
    claims.push({
      targetLabel: "c",
      requirementId: REQ,
      assertion: "missing",
      speechAct: "finding",
      submittedAs: "missingPoints",
      sourceIndex: 0,
      evidenceQuote: missingPoints[0],
      status: "confirmed",
      confirmedBy: SIGNER,
      confirmedAt: AT,
    });
  }
  if (invents) {
    claims.push({
      targetLabel: "a",
      requirementId: "fee-amount",
      assertion: "missing",
      speechAct: "finding",
      submittedAs: "contradictions",
      sourceIndex: 0,
      evidenceQuote: contradictions[0],
      outsideGoldVerdict: "false_finding",
      status: "confirmed",
      confirmedBy: SIGNER,
      confirmedAt: AT,
    });
  }

  const testCase = {
    caseId: id,
    contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
    sourceCaseDigest: judgedSourceCaseDigest(sourceCase),
    responseLabels: ["a", "b", "c"],
    requirements: [
      { id: REQ, description: "the deadline" },
      { id: "fee-amount", description: "the fee" },
    ],
    gold: { missingPoints: [{ requirementId: REQ, targetLabel: "c" }] },
    // Not exhaustive, so an invented finding does not disprove the gold and
    // stop the case being scored.
    goldCompleteness: { missingPoints: false },
  };
  const record = {
    caseId: id,
    contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
    observationRef: observationRefFor(observation),
    reviewedBy: SIGNER,
    reviewedAt: AT,
    sourceCaseDigest: testCase.sourceCaseDigest,
    claims,
  };
  const artifact = buildScoringArtifact({ testCase, record, observation, scoredAt: AT });

  return {
    id,
    bundle: { "case.json": testCase, "observation.json": observation, "record.json": record, "artifact.json": artifact },
    journalEntry: { caseId: id, failure: null, costUsd: 0, observation },
    datasetCase: {
      id,
      language: "ko",
      taskType: "safety_sensitive",
      phenomenon,
      mode: "balanced",
      question,
      responses,
      gold: { missingPoints: [{ id: REQ, anyOf: ["deadline"], description: "the deadline" }] },
      goldCompleteness: { missingPoints: false },
      status: "adopted",
      adoptedBy: "TEST",
      adoptedAt: AT,
    },
  };
};

/** A whole run on disk: dataset, journal, run artifact, judgement bundles. */
const layOutRun = (root, built, over = {}) => {
  const cases = over.datasetCases ?? built.map((item) => item.datasetCase);
  const dataset = {
    version: "test-v1",
    schemaVersion: 1,
    purpose: "decision",
    frozenAt: AT,
    frozenBy: "TEST",
    frozenDigest: datasetDigest({ cases }),
    cases,
    ...over.dataset,
  };
  writeFileSync(join(root, "dataset.json"), `${JSON.stringify(dataset, null, 2)}\n`, "utf8");

  const journalLines = (over.journal ?? built.map((item) => item.journalEntry)).map((entry) =>
    JSON.stringify(entry)
  );
  writeFileSync(join(root, "run.journal.jsonl"), `${journalLines.join("\n")}\n`, "utf8");

  // The run's own record. `datasetDigest` here is what binds the aggregate to
  // the set this run measured, so it is written from the cases the run ran --
  // which is what `over.datasetCases` can then diverge from.
  const runArtifact = {
    summary: {
      datasetPurpose: dataset.purpose,
      datasetVersion: dataset.version,
      datasetDigest: datasetDigest({ cases: built.map((item) => item.datasetCase) }),
      plannedCases: built.length,
      completedCases: journalLines.length,
      generatedAt: AT,
      ...over.summary,
    },
    metrics: {},
  };
  writeFileSync(join(root, "run.json"), `${JSON.stringify(runArtifact, null, 2)}\n`, "utf8");

  const judgements = join(root, "judgements");
  mkdirSync(judgements, { recursive: true });
  for (const item of over.bundles ?? built) {
    const directory = join(judgements, item.id);
    mkdirSync(directory, { recursive: true });
    for (const [file, value] of Object.entries(item.bundle)) {
      writeFileSync(join(directory, file), `${JSON.stringify(value, null, 2)}\n`, "utf8");
    }
  }
  return { dataset, judgements };
};

const report = (root) =>
  spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "scripts/report-ai-review-judged-run.mjs",
      `--run=${join(root, "run.json")}`,
      `--journal=${join(root, "run.journal.jsonl")}`,
      `--dataset=${join(root, "dataset.json")}`,
      `--judgements=${join(root, "judgements")}`,
    ],
    { encoding: "utf8", env: process.env }
  );

/** Every file under a directory, with its digest. */
const fingerprint = (root) => {
  const out = {};
  const walk = (directory) => {
    for (const name of readdirSync(directory, { withFileTypes: true }).sort((l, r) =>
      l.name.localeCompare(r.name)
    )) {
      const path = join(directory, name.name);
      if (name.isDirectory()) walk(path);
      else {
        out[relative(root, path)] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
      }
    }
  };
  walk(root);
  return out;
};

const withRun = (built, over, body) => {
  const root = mkdtempSync(join(tmpdir(), "ai-review judged run-"));
  try {
    const laid = layOutRun(root, built, over ?? {});
    body(root, laid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------

test("the CLI cannot compute the manifest digest it is supposed to read", () => {
  // A static check, because this is the one requirement no input can exercise:
  // a caller that recomputes `datasetDigest` from the dataset it was handed
  // writes a comparison that passes for every set, and the output looks
  // exactly like a correct run. The only way to fail on it is to refuse the
  // caller the means.
  // Comments stripped first: this file's own comment says what not to do, and
  // matching that would make the check pass or fail on prose.
  const source = readFileSync("scripts/report-ai-review-judged-run.mjs", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(
    source,
    /datasetDigest\s*\(/,
    "the report CLI must read the run's recorded digest, never compute one"
  );
  assert.doesNotMatch(source, /from "\.\.\/lib\/aiReviewEvalRun/);
  // And it must not write: it is a report over evidence somebody else made.
  assert.doesNotMatch(source, /writeFileSync|appendFileSync|rmSync|mkdirSync/);
});

test("a stored run reads back to the same numbers the core produces", () => {
  // `r2` said nothing, so it is the missed-everything case. `r3` found the
  // planted item and invented one beside it, which is the case the old
  // negative-only rule could not see.
  const built = [
    buildCase({ id: "r1" }),
    buildCase({ id: "r2", reports: false }),
    buildCase({ id: "r3", invents: true }),
  ];
  withRun(built, {}, (root) => {
    const before = fingerprint(root);
    const result = report(root);
    assert.equal(result.status, 0, result.stderr);
    const out = result.stdout;

    assert.match(out, /plan\s+3 case\(s\), read from the run's record/);
    assert.match(out, /missedEveryPlantedIssueRate\s+1\/3 = 0\.333/);
    assert.match(out, /inventedFindingRate\s+1\/3 = 0\.333/);
    assert.match(out, /\.\.\. findings, not cases\s+1/);

    // No negative-phenomenon case in this run, so the subset has no
    // denominator -- and says so rather than reading zero.
    assert.match(out, /\.\.\. negative subset\s+insufficient evidence \(0\/0\)/);
    assert.doesNotMatch(out, /negative subset\s+0\/0 = 0\.000/);

    // Report only: nothing written, no gate.
    assert.deepEqual(fingerprint(root), before);
    assert.match(out, /not wired to any approval gate/);
  });
});

test("a missing judgement blocks the run instead of shrinking it", () => {
  const built = [buildCase({ id: "s1" }), buildCase({ id: "s2", reports: false })];
  // Everything the run recorded is intact; only the judgement bundle is gone.
  withRun(built, { bundles: [built[0]] }, (root) => {
    const result = report(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /not aggregable/);
    assert.match(result.stdout, /s2: planned in the run and never judged/);
    assert.doesNotMatch(result.stdout, /missedEveryPlantedIssueRate\s+\d/);
  });
});

test("a case the run never finished cannot be completed from its record", () => {
  const built = [buildCase({ id: "t1" }), buildCase({ id: "t2", reports: false })];
  // The run stopped after one case: its journal holds one entry and its own
  // counts say so. The remaining judgement may be sound; the run is not whole.
  withRun(
    built,
    { journal: [built[0].journalEntry], summary: { completedCases: 1 } },
    (root) => {
      const result = report(root);
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.stdout,
        /t2: planned in the run and its journal holds no output/
      );
      assert.doesNotMatch(result.stdout, /missedEveryPlantedIssueRate\s+\d/);
    }
  );
});

test("a run record that disagrees with its own journal is refused", () => {
  const built = [buildCase({ id: "u1" })];
  withRun(built, { summary: { completedCases: 7 } }, (root) => {
    const result = report(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /recorded 7 completed case\(s\) and its journal holds 1/);
  });
});

test("a run that recorded no dataset digest is bound to no set", () => {
  const built = [buildCase({ id: "v1" })];
  withRun(built, { summary: { datasetDigest: undefined } }, (root) => {
    const result = report(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /manifest datasetDigest\s+\(absent\)/);
    assert.match(result.stdout, /records no summary\.datasetDigest/);
    assert.doesNotMatch(result.stdout, /missedEveryPlantedIssueRate\s+\d/);
  });
});

test("another frozen set is refused even when it is internally consistent", () => {
  const built = [buildCase({ id: "w1" }), buildCase({ id: "w2", reports: false })];
  // The dataset on disk is a correctly re-frozen edit: `w2` is relabelled
  // `no_issue`, which would drop it out of the missed-everything denominator.
  // Nothing else about the run is touched, and the run artifact still carries
  // the digest of the set it actually measured.
  const edited = built.map((item) =>
    item.id === "w2" ? { ...item.datasetCase, phenomenon: "no_issue" } : item.datasetCase
  );
  withRun(built, { datasetCases: edited }, (root) => {
    const result = report(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /another frozen set is not this one/);
    assert.doesNotMatch(result.stdout, /missedEveryPlantedIssueRate\s+\d/);
  });
});

test("a judged case this run never produced is reported, not absorbed", () => {
  const built = [buildCase({ id: "x1" })];
  const stranger = buildCase({ id: "x9" });
  withRun(built, { bundles: [...built, stranger] }, (root) => {
    const result = report(root);
    assert.equal(result.status, 0, result.stderr);
    // Caught by the per-case binding rather than by the plan comparison, and
    // that is the better-located message: through this CLI the plan is the
    // dataset's ids, so a bundle for a case outside the run fails on the
    // journal first. The aggregator's "judged, but the plan has no such case"
    // refusal covers a caller that builds its plan some other way.
    assert.match(result.stdout, /x9: the run's journal has no entry for x9/);
    assert.doesNotMatch(result.stdout, /missedEveryPlantedIssueRate\s+\d/);
  });
});

test("a bundle missing a file is named rather than thrown", () => {
  const built = [buildCase({ id: "y1" })];
  withRun(built, {}, (root) => {
    rmSync(join(root, "judgements", "y1", "record.json"));
    const result = report(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /y1: the bundle has no record\.json/);
  });
});

test("the negative subset restricts both sides when there is one", () => {
  const built = [
    buildCase({ id: "z1", phenomenon: "no_issue", reports: false, invents: true }),
    buildCase({ id: "z2", phenomenon: "no_issue", reports: false }),
    buildCase({ id: "z3", invents: true }),
  ];
  withRun(built, {}, (root) => {
    const result = report(root);
    assert.equal(result.status, 0, result.stderr);
    // Two cases invented something, over three scored cases.
    assert.match(result.stdout, /inventedFindingRate\s+2\/3 = 0\.667/);
    // One of the two negative cases did, over two negative cases -- not 2/2.
    assert.match(result.stdout, /\.\.\. negative subset\s+1\/2 = 0\.500/);
    // And the only case that planted anything is `z3`, which found it.
    assert.match(result.stdout, /missedEveryPlantedIssueRate\s+0\/1 = 0\.000/);
  });
});
