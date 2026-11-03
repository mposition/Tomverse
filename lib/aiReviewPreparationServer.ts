import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  assessSampleAdequacy,
  type AiReviewEvalDataset,
} from "./aiReviewEvalCore";
import { datasetDigest, partitionDatasetProblems } from "./aiReviewEvalRun";
import type { AiReviewPreparationCatalog } from "./aiReviewPreparation";

/** Fixed server-owned input. Neither proposals nor imports write into this directory. */
export function readAiReviewPreparationCatalog(
  directory = join(process.cwd(), "docs/ops/ai-review-evaluation-set"),
): AiReviewPreparationCatalog {
  const catalog: AiReviewPreparationCatalog = { sets: [], problems: [] };
  try {
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()) {
      try {
        const dataset = JSON.parse(
          readFileSync(join(directory, file), "utf8"),
        ) as AiReviewEvalDataset;
        if (dataset?.purpose !== "decision") continue;
        const { blocking } = partitionDatasetProblems(dataset);
        if (blocking.length) {
          catalog.problems.push(
            ...blocking.map((problem) => `${file}: ${problem}`),
          );
          continue;
        }
        catalog.sets.push({
          file,
          digest: datasetDigest(dataset),
          dataset,
          shortfalls: assessSampleAdequacy(dataset.cases).shortfalls,
          structuralProblems: [],
        });
      } catch {
        catalog.problems.push(
          `${file}: could not read the evaluation dataset.`,
        );
      }
    }
  } catch {
    catalog.problems.push("The evaluation dataset directory is unavailable.");
  }
  return catalog;
}
