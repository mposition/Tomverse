import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  aggregateJudgedRun,
  type AiReviewJudgedRunEntry,
} from "./aiReviewJudgedRunAggregate";
import {
  judgedScoredClaims,
  observationRefFor,
  type AiReviewJudgementRecord,
  type AiReviewJudgedCase,
  type AiReviewJudgedScoringArtifact,
} from "./aiReviewEvalJudgement";
import type { AiReviewEvalDataset, AiReviewEvalCase } from "./aiReviewEvalCore";
import type {
  AiReviewJudgedRunCatalog,
  AiReviewJudgedRunReport,
} from "./aiReviewJudgedReportTypes";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : null);
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

export type AiReviewJudgedReportPaths = {
  run: string;
  journal: string;
  dataset: string;
  judgements: string;
};

/** Read-only shared file boundary for the CLI and authenticated Admin page. */
export function readAiReviewJudgedRunReport(
  paths: AiReviewJudgedReportPaths,
  id = basename(paths.run),
): AiReviewJudgedRunReport {
  const read = (path: string) => {
    if (statSync(path).size > 50 * 1024 * 1024)
      throw new Error(
        `${basename(path)} exceeds the 50 MiB report input limit`,
      );
    return readFileSync(path, "utf8");
  };
  const run = object(JSON.parse(read(paths.run)));
  const summary = object(run.summary);
  const dataset: unknown = JSON.parse(read(paths.dataset));
  const journal: unknown[] = read(paths.journal)
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`the run journal line ${index + 1} is not valid JSON`);
      }
    });
  const blockers: string[] = [];
  // Provenance comes from the run, never recomputed from the supplied dataset.
  const manifest = { datasetDigest: text(summary.datasetDigest) ?? "" };
  if (!manifest.datasetDigest)
    blockers.push(
      "the run artifact records no summary.datasetDigest, so nothing says which frozen set this run measured",
    );
  const datasetCases = object(dataset).cases;
  const planned = Array.isArray(datasetCases)
    ? datasetCases
        .map((item) => object(item).id)
        .filter((id): id is string => typeof id === "string")
    : [];
  if (!planned.length)
    blockers.push(
      "the frozen dataset names no cases, so there is no plan to read",
    );
  const plannedCases = count(summary.plannedCases);
  const completedCases = count(summary.completedCases);
  if (plannedCases === null)
    blockers.push(
      "the run artifact records no summary.plannedCases, so its plan cannot be checked",
    );
  else if (plannedCases !== planned.length)
    blockers.push(
      `the run planned ${plannedCases} case(s) and this frozen set holds ${planned.length}; the plan cannot be reconstructed from a set the run did not measure`,
    );
  const plannedIds = new Set(planned);
  const journalByCase = new Map<string, ObjectValue[]>();
  for (const [index, raw] of journal.entries()) {
    const entry = object(raw);
    if (typeof entry.caseId !== "string")
      blockers.push(`the run's journal line ${index + 1} names no caseId`);
    else {
      if (!plannedIds.has(entry.caseId))
        blockers.push(
          `the run's journal holds an output for ${entry.caseId}, which this frozen set does not hold; the record describes a run this plan cannot account for`,
        );
      journalByCase.set(entry.caseId, [
        ...(journalByCase.get(entry.caseId) ?? []),
        entry,
      ]);
    }
  }
  const completedInJournal = journal.filter((raw) => {
    const entry = object(raw);
    return (
      typeof entry.caseId === "string" &&
      plannedIds.has(entry.caseId) &&
      entry.observation
    );
  }).length;
  if (completedCases === null)
    blockers.push("the run artifact records no summary.completedCases");
  else {
    if (completedCases !== completedInJournal)
      blockers.push(
        `the run recorded ${completedCases} completed case(s) and its journal holds ${completedInJournal} output(s) for cases in this set; the record disagrees with itself`,
      );
    if (plannedCases !== null && completedCases !== plannedCases)
      blockers.push(
        `the run completed ${completedCases} of ${plannedCases} planned case(s), so it did not measure the whole plan`,
      );
  }
  const plan: Array<{ caseId: string; observationRef: string }> = [];
  for (const caseId of planned) {
    const rows = journalByCase.get(caseId) ?? [];
    if (!rows.length)
      blockers.push(
        `${caseId}: planned in the run and its journal holds no entry, so the plan cannot be completed from what the run recorded`,
      );
    else if (rows.length > 1)
      blockers.push(
        `${caseId}: the run's journal holds ${rows.length} entries, so which output the plan names is ambiguous`,
      );
    else if (!rows[0].observation)
      blockers.push(
        `${caseId}: the run's journal records a failed call${rows[0].failure ? ` (${rows[0].failure})` : ""}, so this case produced no output and the plan cannot be completed`,
      );
    else
      plan.push({
        caseId,
        observationRef: observationRefFor(rows[0].observation),
      });
  }
  const entries: AiReviewJudgedRunEntry[] = [];
  for (const directory of readdirSync(paths.judgements, {
    withFileTypes: true,
  }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!directory.isDirectory()) continue;
    const bundle: Partial<AiReviewJudgedRunEntry> = {};
    let readable = true;
    for (const [key, file] of [
      ["testCase", "case.json"],
      ["observation", "observation.json"],
      ["record", "record.json"],
      ["artifact", "artifact.json"],
    ] as const) {
      try {
        bundle[key] = JSON.parse(
          read(join(paths.judgements, directory.name, file)),
        );
      } catch (error) {
        readable = false;
        blockers.push(
          `${directory.name}: ${object(error).code === "ENOENT" ? `the bundle has no ${file}` : `${file} cannot be read as valid JSON`}`,
        );
      }
    }
    if (readable) entries.push(bundle as AiReviewJudgedRunEntry);
  }
  const result = blockers.length
    ? { aggregable: false as const, blockers }
    : aggregateJudgedRun({
        plan,
        entries,
        runInputs: { journal, dataset },
        manifest,
      });
  // The shared verifier has now checked every shape, identity and stored score.
  const sources: Map<string, AiReviewEvalCase> = result.aggregable
    ? new Map(
        (dataset as AiReviewEvalDataset).cases.map((item) => [item.id, item]),
      )
    : new Map();
  return {
    id,
    datasetVersion: text(summary.datasetVersion),
    datasetDigest: manifest.datasetDigest || null,
    generatedAt: text(summary.generatedAt),
    plannedCases,
    completedCases,
    journalEntries: journal.length,
    bundleCount: entries.length,
    planCount: plan.length,
    result,
    cases: result.aggregable
      ? entries.map((entry) => {
          const record = entry.record as AiReviewJudgementRecord;
          const testCase = entry.testCase as AiReviewJudgedCase;
          const source = sources.get(testCase.caseId)!;
          const population = new Set<AiReviewJudgementRecord["claims"][number]>(
            judgedScoredClaims(record),
          );
          return {
            caseId: testCase.caseId,
            language: source.language,
            taskType: source.taskType,
            phenomenon: source.phenomenon,
            question: source.question,
            responses: source.responses.map(({ label, content }) => ({
              label,
              content,
            })),
            testCase,
            record,
            outcome: (entry.artifact as AiReviewJudgedScoringArtifact).outcome,
            scoredClaimIndexes: record.claims.flatMap((claim, index) =>
              population.has(claim) ? [index] : [],
            ),
          };
        })
      : [],
  };
}

/** Server-configured, read-only reports. No request supplies a filesystem path. */
export function readAiReviewJudgedRunCatalog(
  root = process.env.AI_REVIEW_JUDGED_RUNS_DIR,
): AiReviewJudgedRunCatalog {
  if (!root?.trim())
    return { state: "unconfigured", reports: [], problems: [] };
  const reports: AiReviewJudgedRunReport[] = [],
    problems: string[] = [];
  try {
    const directories = readdirSync(resolve(root), { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const item of directories.slice(0, 20)) {
      const directory = join(root, item.name);
      try {
        reports.push(
          readAiReviewJudgedRunReport(
            {
              run: join(directory, "run.json"),
              journal: join(directory, "run.journal.jsonl"),
              dataset: join(directory, "dataset.json"),
              judgements: join(directory, "judgements"),
            },
            item.name,
          ),
        );
      } catch {
        problems.push(
          `${item.name}: the stored run cannot be read; check its four report inputs`,
        );
      }
    }
    if (directories.length > 20)
      problems.push(
        "Showing the first 20 run directories in descending name order.",
      );
    return { state: "available", reports, problems };
  } catch {
    return {
      state: "unavailable",
      reports: [],
      problems: ["The configured judged-run directory cannot be read."],
    };
  }
}
