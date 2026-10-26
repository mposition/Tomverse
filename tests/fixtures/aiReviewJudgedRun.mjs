// Synthetic stored-run fixture shared by file and browser tests. Never used by the app.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { datasetDigest } from "../../lib/aiReviewEvalRun.ts";
import {
  AI_REVIEW_SCORING_CONTRACT_VERSION,
  buildScoringArtifact,
  judgedSourceCaseDigest,
  observationRefFor,
} from "../../lib/aiReviewEvalJudgement.ts";
const SIGNER = "TEST (not a person)";
const AT = "2026-09-09T00:00:00.000Z";
const REQ = "deadline";

/**
 * One case, as four files plus the rows a run would have recorded about it.
 *
 * `reports` false means the reviewer said nothing, which is what makes a case
 * land in the missed-everything numerator.
 */
export const buildCase = ({
  id,
  reports = true,
  phenomenon = "omission",
  invents = false,
  language = "ko",
  taskType = "safety_sensitive",
}) => {
  const responses = [
    {
      label: "a",
      modelId: "test",
      provider: "test",
      content: `answer a of ${id}`,
    },
    {
      label: "b",
      modelId: "test",
      provider: "test",
      content: `answer b of ${id}`,
    },
    {
      label: "c",
      modelId: "test",
      provider: "test",
      content: `answer c of ${id}`,
    },
  ];
  const question = `[TEST] ${id}`;
  const sourceCase = {
    id,
    question,
    responses: responses.map(({ label, content }) => ({ label, content })),
  };

  const missingPoints = reports ? [`[TEST] ${id}: c omits the deadline`] : [];
  const contradictions = invents
    ? [`[TEST] ${id}: a and b disagree about the fee`]
    : [];
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
  const artifact = buildScoringArtifact({
    testCase,
    record,
    observation,
    scoredAt: AT,
  });

  return {
    id,
    bundle: {
      "case.json": testCase,
      "observation.json": observation,
      "record.json": record,
      "artifact.json": artifact,
    },
    journalEntry: { caseId: id, failure: null, costUsd: 0, observation },
    datasetCase: {
      id,
      language,
      taskType,
      phenomenon,
      mode: "balanced",
      question,
      responses,
      gold: {
        missingPoints: [
          { id: REQ, anyOf: ["deadline"], description: "the deadline" },
        ],
      },
      goldCompleteness: { missingPoints: false },
      status: "adopted",
      adoptedBy: "TEST",
      adoptedAt: AT,
    },
  };
};

/** A whole run on disk: dataset, journal, run artifact, judgement bundles. */
export const layOutRun = (root, built, over = {}) => {
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
  writeFileSync(
    join(root, "dataset.json"),
    `${JSON.stringify(dataset, null, 2)}\n`,
    "utf8",
  );

  const journalLines = (
    over.journal ?? built.map((item) => item.journalEntry)
  ).map((entry) => JSON.stringify(entry));
  writeFileSync(
    join(root, "run.journal.jsonl"),
    `${journalLines.join("\n")}\n`,
    "utf8",
  );

  // The run's own record. `datasetDigest` here is what binds the aggregate to
  // the set this run measured, so it is written from the cases the run ran --
  // which is what `over.datasetCases` can then diverge from.
  const runArtifact = {
    summary: {
      datasetPurpose: dataset.purpose,
      datasetVersion: dataset.version,
      datasetDigest: datasetDigest({
        cases: built.map((item) => item.datasetCase),
      }),
      plannedCases: built.length,
      completedCases: journalLines.length,
      generatedAt: AT,
      ...over.summary,
    },
    metrics: {},
  };
  writeFileSync(
    join(root, "run.json"),
    `${JSON.stringify(runArtifact, null, 2)}\n`,
    "utf8",
  );

  const judgements = join(root, "judgements");
  mkdirSync(judgements, { recursive: true });
  for (const item of over.bundles ?? built) {
    const directory = join(judgements, item.id);
    mkdirSync(directory, { recursive: true });
    for (const [file, value] of Object.entries(item.bundle)) {
      writeFileSync(
        join(directory, file),
        `${JSON.stringify(value, null, 2)}\n`,
        "utf8",
      );
    }
  }
  return { dataset, judgements };
};
