// Offline only. No provider SDK, registry reader, credentials, or live mode.
import { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "../lib/models.ts";
import { benchmarkDigest, DEVELOPMENT_LIMITS, parseBenchmarkJson, parseDevelopmentCorpus, scoreDevelopmentResults } from "../lib/routerDevelopmentBenchmark.ts";
import { buildDevelopmentPlan, validateDevelopmentPlan } from "../lib/routerDevelopmentBenchmarkPlan.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceFiles = [
  "scripts/router-development-benchmark.mjs", "lib/routerDevelopmentBenchmark.ts", "lib/routerDevelopmentBenchmarkPlan.ts",
  "lib/models.ts", "lib/modelPricing.ts", "lib/routerCallLimits.ts", "lib/routerFullCatalogDiagnostic.ts",
  "lib/routerCandidates.ts", "lib/routerDecision.ts", "lib/routerSelection.ts", "lib/routerScorePolicy.ts",
  "lib/routerCostSignal.ts", "lib/chatContextWindow.ts", "lib/chatTokenEstimate.ts", "lib/taskProfileCore.ts",
  "lib/webSearchCapability.ts", "lib/webSearchBackends.ts", "lib/webSearchSuggestion.ts", "lib/modelFinder.ts", "lib/autoFallbackGate.ts", "lib/routingFallbackPolicy.ts",
  "package.json", "package-lock.json", "tsconfig.json",
].sort();

function readBoundedJson(path, maximum) {
  const descriptor = openSync(resolve(path), "r");
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximum) throw new Error("input_file_size_or_type");
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(descriptor, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > maximum) throw new Error("input_file_byte_limit");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } finally { closeSync(descriptor); }
}

function main() {
  const options = new Map();
  const allowed = new Set(["mode", "corpus", "plan", "requested-model", "plan-file", "answers", "output", "help"]);
  for (const argument of process.argv.slice(2)) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argument);
    if (!match || !allowed.has(match[1])) throw new Error("unknown_argument_no_live_mode");
    if (options.has(match[1])) throw new Error("duplicate_argument");
    if (match[1] !== "help" && !match[2]) throw new Error("argument_requires_equals_value");
    options.set(match[1], match[2] ?? true);
  }
  if (options.has("help")) {
    if (options.size !== 1) throw new Error("help_must_be_used_alone");
    console.log("Development fixtures only; no provider calls or credentials.\n" +
      "npm run benchmark:router -- [--mode=dry-run] [--corpus=PATH] [--plan=Pro] [--requested-model=ID] [--output=NEW_PATH]\n" +
      "npm run benchmark:router -- --mode=score --plan-file=PATH --answers=PATH [--corpus=PATH] [--output=NEW_PATH]\n" +
      "Output defaults to stdout. Existing output files are refused. Score requires the original source/corpus/planning snapshot.");
    return;
  }
  const mode = options.get("mode") ?? "dry-run";
  if (mode !== "dry-run" && mode !== "score") throw new Error("unsupported_mode_only_dry_run_or_score");
  if (mode === "dry-run" && (options.has("plan-file") || options.has("answers"))) throw new Error("score_arguments_in_dry_run");
  if (mode === "score" && (!options.has("plan-file") || !options.has("answers") || options.has("plan") || options.has("requested-model"))) throw new Error("score_requires_plan_file_and_answers_no_overrides");
  // Environment overrides affect existing pricing helpers. V1 never silently reads them.
  if (Object.keys(process.env).some((key) => /^CHAT_MODEL_.*_(INPUT_USD_PER_MILLION|OUTPUT_USD_PER_MILLION|CACHED_INPUT_PRICE_MULTIPLIER|MAX_OUTPUT_TOKENS|RESERVATION_OUTPUT_TOKENS)$/i.test(key))) throw new Error("pricing_environment_overrides_unsupported_v1");
  const corpusPath = options.get("corpus") ?? resolve(root, "docs/ops/router-development-benchmark/development-v1.json");
  const corpus = parseDevelopmentCorpus(readBoundedJson(corpusPath, DEVELOPMENT_LIMITS.corpusBytes));
  const source = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain", "--", ...sourceFiles], { cwd: root, encoding: "utf8" }).trim().length > 0,
    files: Object.fromEntries(sourceFiles.map((path) => [path, benchmarkDigest(readFileSync(resolve(root, path), "utf8"))])),
  };
  const common = { corpus, models: AVAILABLE_MODELS, source };
  let output;
  if (mode === "dry-run") {
    output = buildDevelopmentPlan({ ...common, plan: options.get("plan") ?? "Pro", requestedModelId: options.get("requested-model") ?? DEFAULT_MODEL_ID, createdAt: new Date().toISOString() });
  } else {
    const plan = validateDevelopmentPlan(parseBenchmarkJson(readBoundedJson(options.get("plan-file"), DEVELOPMENT_LIMITS.documentBytes)), common);
    output = scoreDevelopmentResults(corpus, plan, parseBenchmarkJson(readBoundedJson(options.get("answers"), DEVELOPMENT_LIMITS.documentBytes)));
  }
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (options.has("output")) {
    const destination = resolve(options.get("output"));
    // Exclusive creation: accidental reruns never overwrite earlier evidence.
    writeFileSync(destination, serialized, { flag: "wx", encoding: "utf8" });
    console.log(JSON.stringify({ mode, output: destination, summary: output.summary }));
  } else process.stdout.write(serialized);
}

try { main(); }
catch (error) {
  // File contents, malformed input, environment values and provider credentials are never echoed.
  const message = error instanceof Error ? error.message : "benchmark_failed";
  console.error(`router-development-benchmark: ${/^[a-zA-Z0-9_.:-]+$/.test(message) ? message : "input_or_output_error"}`);
  process.exitCode = 1;
}
