// Rebuild the compact Admin benchmark from the saved, independently replayable responses.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { MEMORY_PROBE_LOCALES } from "../lib/productResearchScoutMemoryCases.ts";
import {
  ARM_NAMES,
  SCENARIOS,
  EXPERIMENT_VERSION,
  RERANK_MODEL,
  experimentCase,
  armProbe,
  scoreArm,
  summarizeTrials,
} from "../lib/scoutMemoryExperiment.ts";
import { rankMicroUsd } from "../lib/scoutMemoryCohere.ts";
const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw Error("Provide the evidence JSON and destination summary JSON.");
const report = JSON.parse(await readFile(input, "utf8"));
assert.equal(report.version, EXPERIMENT_VERSION);
assert.equal(report.rerankModel, RERANK_MODEL);
assert.equal(
  report.results.length,
  MEMORY_PROBE_LOCALES.length * SCENARIOS.length * ARM_NAMES.length,
);
for (const locale of MEMORY_PROBE_LOCALES)
  for (const scenario of SCENARIOS) {
    const c = experimentCase(report.day, locale, scenario);
    for (const arm of ARM_NAMES) {
      const rows = report.results.filter(
        (r) => r.arm === arm && r.locale === locale && r.scenario === scenario,
      );
      assert.equal(rows.length, 1);
      const r = rows[0];
      assert.equal(r.status, "complete");
      assert.equal(r.model, report.model);
      assert.equal(r.day, report.day);
      assert.equal(r.sourceDigest, c.digest);
      assert.deepEqual(r.expected, c.source.gold);
      if (arm === "cohere") {
        assert.equal(new Set(r.rankedOrdinals).size, 3);
        assert.ok(
          r.rankedOrdinals.every(
            (i) => Number.isInteger(i) && i >= 0 && i < c.rows.length,
          ),
        );
        assert.ok(
          r.rerankTokens === null ||
            (Number.isSafeInteger(r.rerankTokens) && r.rerankTokens >= 0),
        );
        assert.equal(r.retrievalMicroUsd, rankMicroUsd(r.rerankTokens));
      }
      const probe = armProbe(c, arm, r.rankedOrdinals);
      assert.equal(probe.promptDigest, r.promptDigest);
      assert.equal(typeof r.raw, "string");
      for (const [name, value] of Object.entries(scoreArm(c, probe, r.raw)))
        assert.equal(r[name], value);
    }
  }
const summary = {
  model: report.model,
  day: report.day,
  rows: summarizeTrials(report.results, report.model),
};
await writeFile(output, JSON.stringify(summary, null, 2) + "\n");
console.log(
  report.results.length +
    " answers verified across " +
    summary.rows.length +
    " languages.",
);
