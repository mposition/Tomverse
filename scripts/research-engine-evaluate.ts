import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pairResearchRuns, researchReviewSheet, researchReviewSheetCsv, researchRunMetrics } from "@/lib/researchEngineEvaluation";

/**
 * Offline Deep Research comparison over runs that already exist in a
 * development or test database:
 *
 *   npx tsx --conditions=react-server scripts/research-engine-evaluate.ts --runs=<id,id,...> --out=<dir>
 *
 * Writes metrics.json (per run and per same-brief pair) and one review CSV per
 * engine-v2 run for a person to judge claim support. It starts nothing and
 * calls no provider; creating new live runs to compare is a separate, approved
 * action through the product itself.
 */

const production = process.env.NODE_ENV === "production" || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_ID || process.env.VERCEL_ENV === "production";

async function main() {
  if (production) throw new Error("research-engine-evaluate is development-only.");
  const runsArgument = process.argv.find((entry) => entry.startsWith("--runs="))?.slice(7) ?? "";
  const outArgument = process.argv.find((entry) => entry.startsWith("--out="))?.slice(6);
  const runIds = runsArgument.split(",").map((entry) => entry.trim()).filter((entry) => /^[A-Za-z0-9_-]{1,64}$/u.test(entry));
  if (!runIds.length || !outArgument) throw new Error("Usage: --runs=<id,...> --out=<directory>");
  const out = resolve(outArgument);
  mkdirSync(out, { recursive: true });
  const metrics = [];
  for (const runId of runIds) metrics.push(await researchRunMetrics(runId));
  writeFileSync(resolve(out, "metrics.json"), JSON.stringify({ generatedAt: new Date().toISOString(), runs: metrics, pairs: pairResearchRuns(metrics),
    note: "Structure and money only. Claim support is judged by a person in the review CSVs." }, null, 2));
  for (const entry of metrics.filter((metric) => metric.engineVersion === 2)) {
    writeFileSync(resolve(out, `review-${entry.runId}.csv`), researchReviewSheetCsv(await researchReviewSheet(entry.runId)));
  }
  console.log(JSON.stringify({ runs: metrics.length, out }));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Evaluation failed.");
  process.exitCode = 1;
});
