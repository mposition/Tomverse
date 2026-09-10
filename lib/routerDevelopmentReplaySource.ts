/** Fixed historical source paths; an imported manifest never chooses files to read. */
import { benchmarkDigest, canonicalBenchmarkJson, parseBenchmarkJson } from "./routerDevelopmentBenchmark";
import type { DevelopmentSource } from "./routerDevelopmentBenchmarkPlan";

export const REPLAY_SCRIPT_NAME = "benchmark:router:replay";
export const REPLAY_SCRIPT_COMMAND = "node --import tsx scripts/router-development-replay.mjs";
export const REPLAY_BENCHMARK_SOURCE_PATHS = [
  "scripts/router-development-benchmark.mjs", "lib/routerDevelopmentBenchmark.ts", "lib/routerDevelopmentBenchmarkPlan.ts",
  "lib/models.ts", "lib/modelPricing.ts", "lib/routerCallLimits.ts", "lib/routerFullCatalogDiagnostic.ts",
  "lib/routerCandidates.ts", "lib/routerDecision.ts", "lib/routerSelection.ts", "lib/routerScorePolicy.ts",
  "lib/routerCostSignal.ts", "lib/chatContextWindow.ts", "lib/chatTokenEstimate.ts", "lib/taskProfileCore.ts",
  "lib/webSearchCapability.ts", "lib/webSearchBackends.ts", "lib/webSearchSuggestion.ts", "lib/modelFinder.ts", "lib/autoFallbackGate.ts", "lib/routingFallbackPolicy.ts",
  "package.json", "package-lock.json", "tsconfig.json",
].sort();
export const REPLAY_COLLECTOR_SOURCE_PATHS = [...REPLAY_BENCHMARK_SOURCE_PATHS,
  "scripts/router-development-collect.mjs", "lib/routerDevelopmentCollector.ts", "lib/routerDevelopmentCollectorJournal.ts", "lib/routerDevelopmentCollectorProvider.ts",
  "lib/activeAiModel.ts", "lib/modelRegistryShared.ts", "lib/modelGenerationCompatibility.ts", "lib/anthropicPromptCaching.ts",
  "lib/deepseekUsageAdapter.ts", "lib/deepseekUsageAdapterCore.ts", "lib/perplexityUsageCapture.ts", "lib/perplexityUsageCore.ts",
  "scripts/check-processing-tier-core.mjs",
].sort();
export const REPLAY_CORPUS_PATH = "docs/ops/router-development-benchmark/development-v1.json";
export const REPLAY_IMPLEMENTATION_PATHS = [
  "lib/routerDevelopmentReplay.ts", "lib/routerDevelopmentReplaySource.ts", "scripts/router-development-replay.mjs",
];

/** The sole allowed runtime difference is this exact additive npm script. */
export function replayPackageCompatible(originalText: string, currentText: string): boolean {
  const original = parseBenchmarkJson(originalText);
  const current = parseBenchmarkJson(currentText);
  if (!original || !current || Array.isArray(original) || Array.isArray(current) || typeof original !== "object" || typeof current !== "object") return false;
  if (canonicalBenchmarkJson(original) === canonicalBenchmarkJson(current)) return true;
  const scripts = current.scripts;
  const oldScripts = original.scripts;
  if (!scripts || !oldScripts || Array.isArray(scripts) || Array.isArray(oldScripts) || typeof scripts !== "object" || typeof oldScripts !== "object") return false;
  if (Object.hasOwn(oldScripts, REPLAY_SCRIPT_NAME) || scripts[REPLAY_SCRIPT_NAME] !== REPLAY_SCRIPT_COMMAND) return false;
  delete scripts[REPLAY_SCRIPT_NAME];
  return canonicalBenchmarkJson(original) === canonicalBenchmarkJson(current);
}

export function validateReplaySourceFiles(input: {
  observationSourceRef: string;
  anchored: Readonly<Record<string, string>>;
  current: Readonly<Record<string, string>>;
}): { benchmark: DevelopmentSource; collector: DevelopmentSource; corpusFileDigest: string } {
  if (!/^[a-f0-9]{40}$/.test(input.observationSourceRef)) throw new Error("replay_observation_source_ref_required_full_sha");
  for (const path of [...REPLAY_COLLECTOR_SOURCE_PATHS, REPLAY_CORPUS_PATH]) {
    const original = input.anchored[path];
    const current = input.current[path];
    if (typeof original !== "string" || typeof current !== "string") throw new Error("replay_source_file_missing");
    if (original !== current && (path !== "package.json" || !replayPackageCompatible(original, current))) throw new Error("replay_runtime_source_drift");
  }
  const snapshot = (paths: readonly string[]): DevelopmentSource => ({
    commit: input.observationSourceRef, dirty: false,
    files: Object.fromEntries(paths.map((path) => [path, benchmarkDigest(input.anchored[path])])),
  });
  return { benchmark: snapshot(REPLAY_BENCHMARK_SOURCE_PATHS), collector: snapshot(REPLAY_COLLECTOR_SOURCE_PATHS), corpusFileDigest: benchmarkDigest(input.anchored[REPLAY_CORPUS_PATH]) };
}
