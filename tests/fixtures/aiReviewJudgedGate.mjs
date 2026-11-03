import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCase, layOutRun } from "./aiReviewJudgedRun.mjs";
import { emptyJudgedThresholdDraft } from "../../lib/aiReviewJudgedThresholds.ts";
import {
  AI_REVIEW_EVAL_LANGUAGES,
  AI_REVIEW_EVAL_TASK_TYPES,
  AI_REVIEW_EVAL_MODES,
  AI_REVIEW_EVAL_BLIND_SHEET_RULES,
} from "../../lib/aiReviewEvalCore.ts";
import {
  buildScoringArtifact,
  observationRefFor,
} from "../../lib/aiReviewEvalJudgement.ts";
import {
  rebuildBlindSheet,
  renderBlindSheet,
} from "../../lib/aiReviewEvalBlindSheet.ts";
import { renderBlindReviewRecordHeader } from "../../lib/aiReviewBlindReviewRecord.ts";
import {
  verifyEvidenceBundle,
  fileDigest,
} from "../../lib/aiReviewEvidenceBundle.ts";

export const syntheticJudgedThresholds = () => {
  const draft = emptyJudgedThresholdDraft();
  for (const key of Object.keys(draft.minWilsonLower))
    draft.minWilsonLower[key] = 0.5;
  for (const key of Object.keys(draft.maxWilsonUpper))
    draft.maxWilsonUpper[key] = 0.2;
  return {
    ...draft,
    version: "synthetic-judged",
    approvedBy: "TEST ONLY",
    approvedAt: "2026-10-01T00:00:00Z",
    minBlindReviewedCases: 1,
    maxLanguageArmGap: 0.2,
    maxTaskTypeArmShortfall: 0.1,
    negativeSubset: { policy: "diagnostic" },
  };
};

export function buildJudgedGateRun(root) {
  const built = [];
  for (const language of AI_REVIEW_EVAL_LANGUAGES)
    for (const taskType of AI_REVIEW_EVAL_TASK_TYPES)
      for (let i = 0; i < 100; i++) {
        const item = buildCase({
          id: `gate-${built.length}`,
          language,
          taskType,
          invents: true,
        });
        item.datasetCase.mode = AI_REVIEW_EVAL_MODES[built.length % 3];
        item.datasetCase.gold.contradictions = [
          {
            id: "fee-amount",
            anyOf: ["fee"],
            description: "the fee difference",
          },
        ];
        item.datasetCase.goldCompleteness = {
          contradictions: true,
          missingPoints: true,
        };
        const record = item.bundle["record.json"];
        const testCase = item.bundle["case.json"];
        const observation = item.bundle["observation.json"];
        testCase.gold.contradictions = [
          { requirementId: "fee-amount", targetLabel: "a" },
        ];
        testCase.goldCompleteness = {
          contradictions: true,
          missingPoints: true,
        };
        delete record.claims[1].outsideGoldVerdict;
        observation.totalQuotes = 2;
        observation.matchedQuotes = 2;
        record.observationRef = observationRefFor(observation);
        item.bundle["artifact.json"] = buildScoringArtifact({
          testCase,
          observation,
          record,
          scoredAt: "2026-10-02T00:00:00Z",
        });
        built.push(item);
      }
  const { dataset, judgements } = layOutRun(root, built);
  const setDirectory = join(root, "sets");
  mkdirSync(setDirectory);
  const datasetPath = join(setDirectory, "decision.json");
  writeFileSync(datasetPath, JSON.stringify(dataset));
  const thresholds = syntheticJudgedThresholds();
  const thresholdPath = join(root, "thresholds.json");
  writeFileSync(thresholdPath, JSON.stringify(thresholds));
  const identity = {
    runOrdinal: 1,
    reviewerModelId: "TEST",
    promptVersion: "TEST",
    commitSha: "b".repeat(40),
    datasetDigest: dataset.frozenDigest,
    sheetSeed: 1,
    thresholdVersion: thresholds.version,
  };
  const answerKey = Object.fromEntries(
    built.map((item, i) => [
      `S${i}`,
      { caseId: item.id, gold: item.datasetCase.gold },
    ]),
  );
  const journalText = readFileSync(join(root, "run.journal.jsonl"), "utf8");
  const sheetMeta = { ...identity, seed: 1, datasetVersion: dataset.version };
  const blindSheetText = renderBlindSheet(
    rebuildBlindSheet({
      cases: dataset.cases,
      observations: new Map(
        built.map((item) => [item.id, item.journalEntry.observation]),
      ),
      answerKey,
    }),
    sheetMeta,
  );
  const header = renderBlindReviewRecordHeader({
    ...identity,
    blindSheetDigest: fileDigest(blindSheetText),
  })
    .replace("# signed-by: ", "# signed-by: TEST ONLY")
    .replace("# signed-at: ", "# signed-at: 2026-10-02");
  const recordText =
    [
      header,
      ["label", ...AI_REVIEW_EVAL_BLIND_SHEET_RULES, "note"].join(","),
      ...Object.keys(answerKey).map((label) =>
        [label, ...AI_REVIEW_EVAL_BLIND_SHEET_RULES.map(() => "no"), ""].join(
          ",",
        ),
      ),
    ].join("\n") + "\n";
  const recordPath = join(root, "blind-record.csv");
  writeFileSync(recordPath, recordText);
  writeFileSync(join(root, "run--answer-key.json"), JSON.stringify(answerKey));
  writeFileSync(join(root, "run--blind-sheet.md"), blindSheetText);
  const evidence = verifyEvidenceBundle({
    dataset,
    journalText,
    answerKeyText: JSON.stringify(answerKey),
    recordText,
    blindSheetText,
    sheetMeta,
    identity: { ...identity, blindSheetDigest: fileDigest(blindSheetText) },
    minimumReviewedCases: 1,
  });
  const artifact = {
    summary: {
      ...identity,
      datasetPurpose: "decision",
      datasetVersion: dataset.version,
      datasetSchemaVersion: 1,
      decisionGrade: true,
      workingTreeDirty: false,
      adjudicated: true,
      humanBlindReviewRef: recordPath,
      blindReviewThresholdVersion: thresholds.version,
      blindReviewSheetSeed: 1,
      plannedCases: evidence.derived.plannedCases,
      completedCases: evidence.derived.completedCases,
      sampleAdequate: evidence.derived.sampleAdequate,
      zeroToleranceViolations: evidence.zeroToleranceViolations,
      blindReviewSignedBy: evidence.derived.signedBy,
      blindReviewSignedAt: evidence.derived.signedAt,
      blindSheetDigest: evidence.derived.blindSheetDigest,
      blindReviewCasesJudged: evidence.derived.reviewedCases,
      blindReviewRulesJudged: 5,
      blindReviewRecordDigest: evidence.derived.recordDigest,
      blindReviewAnswerKeyDigest: evidence.derived.answerKeyDigest,
      journalDigest: evidence.derived.journalDigest,
    },
    metrics: evidence.metrics,
  };
  const run = join(root, "run.json");
  writeFileSync(run, JSON.stringify(artifact));
  const registerPath = join(root, "register.json");
  writeFileSync(registerPath, "[]");
  return {
    thresholds,
    thresholdPath,
    registerPath,
    setDirectory,
    evidence,
    paths: {
      run,
      journal: join(root, "run.journal.jsonl"),
      dataset: datasetPath,
      judgements,
    },
  };
}
