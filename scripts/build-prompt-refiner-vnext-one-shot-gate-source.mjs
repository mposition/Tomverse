import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root,
  "docs/ops/prompt-refiner-quality-evaluation-vnext-one-shot-gate-source.json");
const files = [
  "lib/promptRefinerVnextOneShotGateSource.ts",
  "lib/promptRefinerVnextOneShotGateSummary.ts",
  "lib/promptRefinerVnextOneShotGateAttestation.ts",
  "lib/promptRefinerVnextOneShotOwnerGate.ts",
  "lib/promptRefinerVnextOneShotOwnerSeal.ts",
  "lib/promptRefinerQualityEvaluationVnextOneShotPredicateCore.ts",
  "lib/promptRefinerQualityEvaluationVnextOneShotManifestEnvelope.ts",
  "lib/promptRefinerQualityEvaluationVnextExecutionContract.ts",
  "lib/promptRefinerQualityEvaluationVnextCore.ts",
  "lib/providerUsageCost.ts",
  "lib/routerDevelopmentBenchmark.ts",
  "scripts/prompt-refiner-vnext-one-shot-owner-gate.mjs",
  "scripts/prompt-refiner-vnext-one-shot-check-manifest.mjs",
  "docs/ops/prompt-refiner-quality-evaluation-vnext-one-shot-primitives-closure.json",
  "docs/ops/prompt-refiner-quality-evaluation-vnext-one-shot-predicate-core-closure.json",
  "docs/ops/prompt-refiner-quality-evaluation-vnext-one-shot-manifest-witnesses-closure.json",
  "docs/ops/prompt-refiner-quality-evaluation-vnext-one-shot-manifest-rubrics-closure.json",
  "docs/ops/prompt-refiner-quality-evaluation-vnext-one-shot-manifest-envelope-closure.json",
  "docs/ops/prompt-refiner-quality-evaluation-vnext-one-shot-manifest-core-closure.json",
  "docs/ops/prompt-refiner-quality-evaluation-vnext-one-shot-format-witness-closure.json",
  "docs/ops/prompt-refiner-quality-evaluation-vnext-one-shot-challenge-witness-closure.json",
];
const manifest = { version: "prompt-refiner-vnext-one-shot-gate-source-v1",
  files: Object.fromEntries(files.map((relative) => [relative,
    createHash("sha256").update(readFileSync(resolve(root, relative)))
      .digest("hex")])) };
const expected = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.argv.slice(2).join(" ") === "--verify") {
  if (readFileSync(output, "utf8") !== expected) {
    process.stderr.write("gate_source_mismatch\n");
    process.exitCode = 1;
  }
} else if (process.argv.length === 2) {
  writeFileSync(output, expected, { encoding: "utf8", flag: "w" });
} else {
  process.stderr.write("usage_invalid\n");
  process.exitCode = 2;
}
