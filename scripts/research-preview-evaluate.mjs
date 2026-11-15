// Development-only. Preview imports no provider clients and makes no network calls.
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildResearchEvaluationManifest, resolveResearchEvaluationModel, researchEvaluationDigest,
  researchEvaluationMeasuredCost, validateResearchEvaluationApproval, rerankResearchEvaluationSnippets,
  RESEARCH_EVALUATION_MAX_MICRO_USD } from "../lib/researchPreviewEvaluation.ts";
import { writeCollectionDurably, readCollectionText } from "../lib/routerDevelopmentCollectorJournal.ts";
import { curateResearchPageEvidence } from "../lib/researchPreviewPageEvidence.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = [
  "lib/researchPreviewEvaluation.ts", "scripts/research-preview-evaluate.mjs", "lib/researchPreviewStep.ts",
  "lib/researchPreviewExecution.ts", "lib/researchPreviewPrompt.ts", "lib/researchPreviewBudget.ts",
  "lib/researchPreviewReport.ts", "lib/researchPreviewPageRead.ts", "lib/researchPreviewPageEvidence.ts",
  "lib/researchPreviewAdmission.ts", "lib/researchPreviewModel.ts", "lib/cohereResearchFetch.ts",
  "lib/appManagedWebSearchTool.ts", "lib/appManagedWebSearchCore.ts", "lib/webSearchBackendAdapter.ts",
  "lib/webSearchBackendPricing.ts", "lib/webSearchBackendRuntime.ts", "lib/webSearchBackends.ts",
  "lib/webSearchCapability.ts", "lib/boundedBuffer.ts", "lib/models.ts", "lib/modelPricing.ts",
  "lib/activeAiModel.ts", "lib/modelRegistryShared.ts", "lib/modelGenerationCompatibility.ts",
  "lib/chatSecurity.ts", "lib/chatTokenEstimate.ts", "lib/providerUsageCost.ts",
  "lib/webSearchNativeCostReservation.ts", "lib/routerDevelopmentCollectorJournal.ts", "package-lock.json",
];
const sourceDigest = () => researchEvaluationDigest(sources.map(path => [path, readFileSync(resolve(root, path), "utf8")]));
const readJson = path => JSON.parse(readCollectionText(resolve(path), 2 * 1024 * 1024));
const production = env => env.NODE_ENV === "production" || env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_ID || env.VERCEL_ENV === "production";
const diagnosticErrorNames = new Set(["Error", "TypeError", "AbortError", "TimeoutError", "AI_APICallError", "AI_NoOutputGeneratedError", "AI_TypeValidationError", "AI_RetryError", "ResearchPreviewUsageUnknownError", "ResearchPreviewBudgetExhaustedError"]);
function failureDiagnostic(error) {
  const errorType = diagnosticErrorNames.has(error?.name) ? error.name : "OtherError";
  const diagnostic = { errorType };
  for (let cause = error, depth = 0; cause && typeof cause === "object" && depth < 4; cause = cause.cause, depth++) {
    if (Number.isInteger(cause.statusCode) && cause.statusCode >= 100 && cause.statusCode <= 599) {
      diagnostic.httpStatus = cause.statusCode;
      break;
    }
  }
  // Never retain provider messages, request bodies, headers or response bodies.
  if (["RESEARCH_PROVIDER_CONTINUATION_REFUSED", "RESEARCH_PROVIDER_REQUEST_UNAVAILABLE"].includes(error?.message)) diagnostic.code = error.message;
  return diagnostic;
}
const help = "Preview: npm run research:preview:evaluate -- [--models=gemini-4-argon,gpt-6-luna] [--cases=official-runtime-support] [--request-input-ceiling=32768] [--rerank] [--max-total-microusd=10000000] --expires-at=UTC [--output=NEW_PATH]\nExecute: npm run research:preview:evaluate -- --mode=execute --manifest=PATH --approval=PATH --live\nClosed models: gemini-4-argon, gpt-6-luna, gemini-3-1-pro, command-a-plus. At most two model/brief pairs, six generation calls, one optional Rerank 5 Fast side experiment and US$10. Requires separately approved development provider and Brave credentials; no production credits/budgets. Interrupted/unknown intent is never retried automatically.";

async function loadProviders() {
  const [{ getResearchPreviewAiModel }, { runResearchPreviewStep }, { readResearchPage }, { resolveProviderApiKey }] = await Promise.all([
    import("../lib/researchPreviewModel.ts"), import("../lib/researchPreviewStep.ts"), import("../lib/researchPreviewPageRead.ts"), import("../lib/modelRegistryShared.ts"),
  ]);
  return { getResearchPreviewAiModel, runResearchPreviewStep, readResearchPage, resolveProviderApiKey, rerank: rerankResearchEvaluationSnippets };
}

/** Narrow seams let offline tests exercise the actual durable journal and CLI admission. */
export async function runResearchEvaluationCli(args, seams = {}) {
  const options = new Map();
  for (const argument of args) {
    const match = /^--(mode|manifest|approval|output|cases|models|rerank|request-input-ceiling|max-total-microusd|expires-at|live|help)(?:=(.*))?$/.exec(argument);
    if (!match || options.has(match[1]) || (["live", "help", "rerank"].includes(match[1]) ? match[2] !== undefined : !match[2])) throw new Error("Invalid evaluation arguments");
    options.set(match[1], match[2] ?? true);
  }
  if (options.has("help")) return { help };
  const digest = seams.sourceDigest ?? sourceDigest;
  const now = seams.now ?? Date.now;
  const env = seams.env ?? process.env;
  const mode = options.get("mode") ?? "preview";
  if (mode === "preview") {
    if (["manifest", "approval", "live"].some(key => options.has(key))) throw new Error("Execution flags cannot be used in preview");
    const manifest = buildResearchEvaluationManifest({ sourceDigest: digest(), currentDate: new Date(now()).toISOString().slice(0, 10),
      expiresAt: options.get("expires-at"), maxTotalMicroUsd: options.has("max-total-microusd") ? Number(options.get("max-total-microusd")) : RESEARCH_EVALUATION_MAX_MICRO_USD,
      ...(options.has("cases") ? { caseIds: options.get("cases").split(",") } : {}),
      ...(options.has("models") ? { modelIds: options.get("models").split(",") } : {}), rerank: options.has("rerank"),
      ...(options.has("request-input-ceiling") ? { requestInputCeilingTokens: Number(options.get("request-input-ceiling")) } : {}) });
    if (options.has("output")) writeCollectionDurably(resolve(options.get("output")), JSON.stringify(manifest, null, 2) + "\n", "wx");
    return { mode, manifest };
  }
  if (mode !== "execute" || !options.has("manifest") || !options.has("approval") || !options.has("live") ||
      ["cases", "models", "rerank", "request-input-ceiling", "max-total-microusd", "expires-at", "output"].some(key => options.has(key))) throw new Error("Execution requires an unchanged manifest, approval and --live");
  if (production(env)) throw new Error("Research evaluation must run in a local development process");
  const supplied = readJson(options.get("manifest"));
  const manifest = buildResearchEvaluationManifest({ sourceDigest: digest(), currentDate: supplied.currentDate, expiresAt: supplied.expiresAt,
    maxTotalMicroUsd: supplied.maxTotalMicroUsd, caseIds: [...new Set(supplied.cases.map(entry => entry.id))],
    modelIds: supplied.models.map(entry => entry.id), rerank: supplied.rerank.enabled,
    ...(supplied.requestInputCeilingTokens !== undefined ? { requestInputCeilingTokens: supplied.requestInputCeilingTokens } : {}) });
  if (researchEvaluationDigest(manifest) !== researchEvaluationDigest(supplied)) throw new Error("Evaluation source, pricing or manifest changed");
  const approval = validateResearchEvaluationApproval(readJson(options.get("approval")), manifest, now());
  if (Object.keys(env).some(key => /^CHAT_MODEL_.*_(INPUT_USD_PER_MILLION|OUTPUT_USD_PER_MILLION|CACHED_INPUT_PRICE_MULTIPLIER|MAX_OUTPUT_TOKENS|RESERVATION_OUTPUT_TOKENS)$/i.test(key))) throw new Error("Pricing environment overrides are not allowed");
  if (env.WEB_SEARCH_FAKE_BACKEND === "1" || !env.BRAVE_SEARCH_API_KEY) throw new Error("Development Brave credential required; fake backend forbidden");
  const providers = await (seams.loadProviders ?? loadProviders)();
  for (const provider of manifest.providers.filter(provider => provider !== "brave")) {
    if (!providers.resolveProviderApiKey(provider)) throw new Error(`Development ${provider} credential required`);
  }
  const stateRoot = seams.stateDirectory ?? resolve(root, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim(), "research-preview-evaluation-v2");
  mkdirSync(stateRoot, { recursive: true });
  const journal = resolve(stateRoot, `${manifest.manifestDigest}.jsonl`);
  if (existsSync(journal)) throw new Error("This evaluation already has an intent; inspect its outcome before requesting a new evaluation");
  writeCollectionDurably(journal, JSON.stringify({ kind: "reserved", at: new Date(now()).toISOString(), manifest, approval }) + "\n", "wx");
  const record = event => writeCollectionDurably(journal, JSON.stringify({ at: new Date(now()).toISOString(), ...event }) + "\n", "a");
  let modelCalls = 0, rerankCalls = 0, measuredTotalMicroUsd = 0, rerankInput;
  const revalidate = () => {
    validateResearchEvaluationApproval(approval, manifest, now());
    if (production(env) || digest() !== manifest.sourceDigest) throw new Error("Evaluation source or environment drift");
  };
  try {
    for (const entry of manifest.cases) {
      const modelConfig = resolveResearchEvaluationModel(entry.modelId);
      let checkpoint;
      const startedAt = now(), signal = AbortSignal.timeout(manifest.timeoutMsPerCase);
      for (let index = 0; index < 3; index++) {
        let claimed = false;
        const result = await providers.runResearchPreviewStep({ model: providers.getResearchPreviewAiModel(modelConfig), modelConfig,
          question: entry.question, locale: entry.locale, currentDate: manifest.currentDate, totalOutputTokens: entry.budget.maxOutputTokens,
          inputTokenCeiling: entry.budget.contextInputTokens, pageReadingEnabled: true, checkpoint, signal,
          pageReader: input => providers.readResearchPage({ ...input, env: { ...env, RESEARCH_PREVIEW_ENABLED: "true", RESEARCH_PREVIEW_PAGE_READING_ENABLED: "true" } }),
          onBeforeModelDispatch: async () => {
            revalidate(); if (claimed || modelCalls >= manifest.maxModelCalls) throw new Error("Evaluation model-call authorization exhausted");
            claimed = true; modelCalls++;
            record({ kind: "dispatch_intent", runKey: entry.runKey, modelId: entry.modelId, caseId: entry.id, generation: index + 1 });
          } });
        checkpoint = result.checkpoint;
        if (!claimed) throw new Error("Evaluation returned without a durable dispatch intent");
        record({ kind: "checkpoint", runKey: entry.runKey, modelId: entry.modelId, completedSteps: checkpoint.completedSteps,
          usage: checkpoint.usage, searchCount: checkpoint.search.backendRequestCount, pageReadCount: checkpoint.pageReads.length,
          pageReads: checkpoint.pageReads.map(page => ({ sourceId: page.sourceId, url: page.url, ...curateResearchPageEvidence(page),
            ...(page.status === "read" ? { contentCharacters: page.content.length, contentDigest: researchEvaluationDigest(page.content) } : {}) })) });
        if (checkpoint.search.backendRequestCount !== checkpoint.search.succeededRequestCount) throw new Error("Evaluation search usage may be unknown");
        if (result.finished) {
          const measuredCostMicroUsd = researchEvaluationMeasuredCost(checkpoint.usage, entry, checkpoint.search.succeededRequestCount);
          if (measuredCostMicroUsd === null || measuredCostMicroUsd > entry.reservedMicroUsd) throw new Error("Evaluation cost is unknown or exceeds its authorization");
          measuredTotalMicroUsd += measuredCostMicroUsd;
          record({ kind: "terminal", runKey: entry.runKey, modelId: entry.modelId, caseId: entry.id, stopReason: checkpoint.stopReason,
            reportRejection: result.reportRejection ?? null,
            outcome: result.report?.outcome ?? null, citedSources: (result.report?.citedSources ?? []).map(source => ({
              sourceId: source.sourceId, url: source.url, ...(source.pageRead ? { pageRead: curateResearchPageEvidence(source.pageRead) } : {}) })),
            content: result.report?.content ?? null, latencyMs: now() - startedAt, usage: checkpoint.usage, measuredCostMicroUsd, qualityVerdict: "manual_review_pending" });
          if (!rerankInput) rerankInput = { query: entry.question, sources: checkpoint.sources, runKey: entry.runKey };
          break;
        }
        if (index === 2) throw new Error("Evaluation ended without a terminal outcome");
      }
    }
    if (manifest.rerank.enabled && rerankInput?.sources.some(source => source.snippet?.trim())) {
      const ranking = await (providers.rerank ?? rerankResearchEvaluationSnippets)({ key: providers.resolveProviderApiKey("cohere"),
        query: rerankInput.query, sources: rerankInput.sources, onBeforeDispatch: async () => {
          revalidate(); if (rerankCalls >= manifest.maxRerankCalls) throw new Error("Evaluation rerank authorization exhausted");
          rerankCalls++; record({ kind: "rerank_dispatch_intent", runKey: rerankInput.runKey, model: manifest.rerank.model });
        } });
      if (ranking.measuredCostMicroUsd > manifest.rerank.reservedMicroUsd) throw new Error("Rerank cost exceeds its authorization");
      measuredTotalMicroUsd += ranking.measuredCostMicroUsd;
      record({ kind: "rerank_terminal", runKey: rerankInput.runKey, ...ranking, qualityVerdict: "manual_review_pending" });
    } else if (manifest.rerank.enabled) record({ kind: "rerank_skipped", reason: "no_public_search_snippets" });
    if (measuredTotalMicroUsd > manifest.maxTotalMicroUsd) throw new Error("Evaluation cost exceeds its authorization");
    record({ kind: "evaluation_completed", modelCalls, rerankCalls, measuredTotalMicroUsd });
    return { journal, status: "completed", modelCalls, rerankCalls, measuredTotalMicroUsd, qualityVerdict: "manual_review_pending" };
  } catch (error) {
    record({ kind: "attention", reason: "dispatch_or_usage_outcome_may_be_unknown_no_automatic_retry", diagnostic: failureDiagnostic(error) });
    throw new Error("Evaluation stopped; inspect the durable journal before any new paid execution");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runResearchEvaluationCli(process.argv.slice(2));
    console.log(result.help ?? JSON.stringify(result.mode === "preview" ? result.manifest : result, null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : "Evaluation failed"); process.exitCode = 1; }
}
