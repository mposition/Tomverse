// Operator-funded DEVELOPMENT collector. Preview/export never import provider clients.
import { execFileSync } from "node:child_process";
import { realpathSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "../lib/models.ts";
import { getModelGenerationSettings } from "../lib/modelGenerationCompatibility.ts";
import { benchmarkDigest, canonicalBenchmarkJson, DEVELOPMENT_LIMITS, parseBenchmarkJson, parseDevelopmentCorpus, strictBenchmarkObject } from "../lib/routerDevelopmentBenchmark.ts";
import { buildDevelopmentPlan, validateDevelopmentPlan } from "../lib/routerDevelopmentBenchmarkPlan.ts";
import { buildCollectionManifest, collectionPricing, COLLECTION_ASSUMPTIONS, collectionHash, validateCollectionApproval, validateCollectionManifest } from "../lib/routerDevelopmentCollector.ts";
import { collectDevelopment, collectorPaths, exportDevelopmentCollection, readCollectionText, writeCollectionDurably } from "../lib/routerDevelopmentCollectorJournal.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Trusted, fixed paths, never paths taken from an untrusted manifest. The v1 list stays byte-compatible.
const benchmarkSources = [
  "scripts/router-development-benchmark.mjs", "lib/routerDevelopmentBenchmark.ts", "lib/routerDevelopmentBenchmarkPlan.ts",
  "lib/models.ts", "lib/modelPricing.ts", "lib/routerCallLimits.ts", "lib/routerFullCatalogDiagnostic.ts",
  "lib/routerCandidates.ts", "lib/routerDecision.ts", "lib/routerSelection.ts", "lib/routerScorePolicy.ts",
  "lib/routerCostSignal.ts", "lib/chatContextWindow.ts", "lib/chatTokenEstimate.ts", "lib/taskProfileCore.ts",
  "lib/webSearchCapability.ts", "lib/webSearchBackends.ts", "lib/webSearchSuggestion.ts", "lib/modelFinder.ts", "lib/autoFallbackGate.ts", "lib/routingFallbackPolicy.ts",
  "package.json", "package-lock.json", "tsconfig.json",
].sort();
const collectorSources = [...benchmarkSources,
  "scripts/router-development-collect.mjs", "lib/routerDevelopmentCollector.ts", "lib/routerDevelopmentCollectorJournal.ts", "lib/routerDevelopmentCollectorProvider.ts",
  "lib/activeAiModel.ts", "lib/modelRegistryShared.ts", "lib/modelGenerationCompatibility.ts", "lib/anthropicPromptCaching.ts",
  "lib/deepseekUsageAdapter.ts", "lib/deepseekUsageAdapterCore.ts", "lib/perplexityUsageCapture.ts", "lib/perplexityUsageCore.ts",
  "scripts/check-processing-tier-core.mjs",
].sort();
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
function snapshot(paths) {
  return { commit: git(["rev-parse", "HEAD"]), dirty: Boolean(git(["status", "--porcelain", "--", ...paths])),
    files: Object.fromEntries(paths.map((path) => [path, benchmarkDigest(readFileSync(resolve(root, path), "utf8"))])) };
}
function readJson(path, maximum = DEVELOPMENT_LIMITS.documentBytes) { return parseBenchmarkJson(readCollectionText(resolve(path), maximum), maximum); }
function inputs() {
  if (Object.keys(process.env).some((key) => /^CHAT_MODEL_.*_(INPUT_USD_PER_MILLION|OUTPUT_USD_PER_MILLION|CACHED_INPUT_PRICE_MULTIPLIER|MAX_OUTPUT_TOKENS|RESERVATION_OUTPUT_TOKENS)$/i.test(key))) throw new Error("collector_pricing_environment_overrides");
  const corpus = parseDevelopmentCorpus(readCollectionText(resolve(root, "docs/ops/router-development-benchmark/development-v1.json"), DEVELOPMENT_LIMITS.corpusBytes));
  return { corpus, models: AVAILABLE_MODELS, source: snapshot(benchmarkSources) };
}
const help = "Development-only; actual provider calls require a separate human budget approval. No production account credits or shared provider budgets are used.\n" +
  "npm run benchmark:router:collect -- [--mode=preview] [--plan=Pro] [--requested-model=ID] [--output=NEW_PATH]\n" +
  "Proposal: add --rows=ROW_ID,ROW_ID --max-total-microusd=N --max-request-microusd=N --max-calls=N --request-timeout-ms=N --run-timeout-ms=N --expires-at=UTC_INSTANT\n" +
  "Execute: --mode=execute --manifest=PATH --approval=PATH --live [--output=NEW_PATH]\n" +
  "Export: --mode=export --manifest=PATH --approval=PATH [--output=NEW_PATH]\n" +
  "No budget defaults or automatic approvals. Fixed state is in git common-dir/router-development-collector-v1.1, shared across this clone's worktrees. Reservations never release; they are not actual spend. No hard network ingress byte/memory cap. Stale locks require operator investigation, never automatic deletion.";
async function main() {
  const options = new Map();
  const valueFlags = ["mode", "plan", "requested-model", "rows", "max-total-microusd", "max-request-microusd", "max-calls", "request-timeout-ms", "run-timeout-ms", "expires-at", "manifest", "approval", "output"];
  for (const arg of process.argv.slice(2)) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match || ![...valueFlags, "live", "help"].includes(match[1])) throw new Error("collector_unknown_argument");
    if (options.has(match[1])) throw new Error("collector_duplicate_argument");
    if (valueFlags.includes(match[1]) ? !match[2] : match[2] !== undefined) throw new Error("collector_argument_value");
    options.set(match[1], match[2] ?? true);
  }
  if (options.has("help")) { if (options.size !== 1) throw new Error("collector_help_alone"); console.log(help); return; }
  const mode = options.get("mode") ?? "preview";
  if (!["preview", "execute", "export"].includes(mode)) throw new Error("collector_unknown_mode");
  const proposalFlags = ["rows", "max-total-microusd", "max-request-microusd", "max-calls", "request-timeout-ms", "run-timeout-ms", "expires-at"];
  if (mode === "preview" && ["manifest", "approval", "live"].some((key) => options.has(key))) throw new Error("collector_execution_flags_in_preview");
  if (mode !== "preview" && (!options.has("manifest") || !options.has("approval") || [...proposalFlags, "plan", "requested-model"].some((key) => options.has(key)))) throw new Error("collector_manifest_approval_required_no_overrides");
  if ((mode === "execute") !== options.has("live")) throw new Error("collector_live_flag_required_execute_only");
  const commonDir = realpathSync(resolve(root, git(["rev-parse", "--git-common-dir"])));
  const outputPath = options.has("output") ? resolve(options.get("output")) : null;
  if (outputPath) {
    const outputParent = realpathSync(dirname(outputPath));
    const path = resolve(outputParent, outputPath.slice(dirname(outputPath).length + 1));
    const insideCommon = relative(commonDir, path);
    if (!insideCommon || (!insideCommon.startsWith("..") && !isAbsolute(insideCommon)) || existsSync(path)) throw new Error("collector_output_existing_or_state_path");
  }
  const common = inputs();
  let result;
  if (mode === "preview") {
    const plan = buildDevelopmentPlan({ ...common, createdAt: new Date().toISOString(), plan: options.get("plan") ?? "Pro", requestedModelId: options.get("requested-model") ?? DEFAULT_MODEL_ID });
    if (proposalFlags.some((key) => options.has(key))) {
      if (!proposalFlags.every((key) => options.has(key))) throw new Error("collector_explicit_limits_and_rows_required");
      const integer = (key) => { const value = options.get(key); if (!/^[1-9]\d*$/.test(value)) throw new Error("collector_integer_argument"); return Number(value); };
      result = buildCollectionManifest({ plan, models: AVAILABLE_MODELS, collectorSource: snapshot(collectorSources), selectedRowIds: options.get("rows").split(","), limits: {
        maxTotalMicroUsd: integer("max-total-microusd"), maxRequestMicroUsd: integer("max-request-microusd"), maxCalls: integer("max-calls"), requestTimeoutMs: integer("request-timeout-ms"), runTimeoutMs: integer("run-timeout-ms"), expiresAt: options.get("expires-at"),
      } });
    } else result = { purpose: "development-only", mode, plan, collectionManifest: null, approval: null, requiredProposalFlags: proposalFlags, assumptions: COLLECTION_ASSUMPTIONS };
  } else {
    const raw = readJson(options.get("manifest"));
    strictBenchmarkObject(raw, ["schemaVersion", "purpose", "status", "plan", "collectorSource", "selectedRowIds", "calls", "limits", "assumptions", "totalReservedMicroUsd", "completionPossibleWithinLimits", "manifestDigest"], "collection_manifest");
    const plan = validateDevelopmentPlan(raw.plan, common);
    const collectorSource = snapshot(collectorSources);
    const manifest = validateCollectionManifest(raw, { plan, models: AVAILABLE_MODELS, collectorSource });
    const approval = validateCollectionApproval(readJson(options.get("approval")), manifest, Date.now(), mode === "export");
    const run = { manifest, approval, commonDir };
    if (mode === "export") result = await exportDevelopmentCollection(run);
    else {
      const assertCurrent = () => {
        // Every request checks current source and active price revision. Never silently re-price.
        if (collectionHash(snapshot(benchmarkSources)) !== collectionHash(plan.source) || collectionHash(snapshot(collectorSources)) !== collectionHash(collectorSource)) throw new Error("collector_source_drift");
        const instant = Date.now();
        for (const call of manifest.calls) {
          const row = plan.rows.find((entry) => entry.rowId === call.rowId);
          const model = AVAILABLE_MODELS.find((entry) => entry.id === row.modelId);
          if (collectionHash(collectionPricing(model, instant)) !== collectionHash(call.pricing) || canonicalBenchmarkJson(getModelGenerationSettings(model)) !== canonicalBenchmarkJson(call.settings)) throw new Error("collector_pricing_or_settings_drift");
        }
      };
      result = await collectDevelopment({ ...run, assertCurrent, adapter: async (request) => {
        const { collectFromProvider } = await import("../lib/routerDevelopmentCollectorProvider.ts");
        return collectFromProvider(request);
      } });
      result.stateLocation = collectorPaths(commonDir, approval.approvalId).root;
    }
  }
  const serialized = `${canonicalBenchmarkJson(result)}\n`;
  if (outputPath) { writeCollectionDurably(outputPath, serialized, "wx"); console.log(JSON.stringify({ mode, output: outputPath })); }
  else process.stdout.write(serialized);
}
try { await main(); }
catch (error) {
  const code = error instanceof Error && /^collector_[a-zA-Z0-9_]+$/.test(error.message) ? error.message : "collector_input_output_or_snapshot_error";
  console.error(code); process.exitCode = 1;
}
