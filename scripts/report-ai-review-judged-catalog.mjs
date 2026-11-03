// The Admin catalog's own read path, usable before configuring a server.
import { readAiReviewJudgedRunCatalog } from "../lib/aiReviewJudgedRunReport.ts";
const args = process.argv.slice(2);
const inline = args.find((value) => value.startsWith("--dir="));
const at = args.indexOf("--dir");
const directory =
  inline?.slice(6) ??
  (at >= 0 ? args[at + 1] : undefined) ??
  process.env.AI_REVIEW_JUDGED_RUNS_DIR;
const catalog = readAiReviewJudgedRunCatalog(directory);
console.log(
  `Catalog: ${catalog.state}. This is a report connection check, not promotion approval.`,
);
for (const problem of catalog.problems) console.log(`  - ${problem}`);
for (const report of catalog.reports) {
  console.log(
    `${report.id}: ${report.result.aggregable ? "verified, aggregable" : "not aggregable"} (${report.completedCases ?? "unknown"}/${report.plannedCases ?? "unknown"})`,
  );
  if (!report.result.aggregable)
    for (const blocker of report.result.blockers) console.log(`  - ${blocker}`);
}
if (catalog.state !== "available") process.exitCode = 1;
