// Offline dry run of the Auto cost-efficiency diagnostic. No provider client, no database,
// no network, no credential. It builds the run manifest from the static catalogue and runs
// the real cycle (lib/autoRouterOptimizerCore.ts, objective chat_cost_efficiency) with
// deterministic mock calls over the KO/EN contract fixtures and the development corpus.
//
// A mock report proves code behaviour only. It is never model quality, never a saving and
// never statistical non-inferiority. A paid run goes through Admin's existing optimizer start
// (default-off AUTO_ROUTER_COST_EFFICIENCY_DIAGNOSTIC switch, existing spending ceilings, audit).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "../lib/models.ts";
import { AUTO_LLM_ROUTER_DEFAULT_GUIDANCE } from "../lib/autoLlmRouterCore.ts";
import { NO_WEB_SEARCH_BACKENDS } from "../lib/webSearchBackends.ts";
import { preflightInputEstimate } from "../lib/autoDispatchPreflight.ts";
import { resolveModelPricing } from "../lib/modelPricing.ts";
import { observeOptimizerUsageCost, optimizerCostFields } from "../lib/autoOptimizerCost.ts";
import {
  AUTO_ROUTER_OPTIMIZER_RUN_CAP_MICRO_USD, AUTO_ROUTER_OPTIMIZER_SAMPLE_MAX, runOptimizerCycle, splitOptimizerDecisionsByFamily,
} from "../lib/autoRouterOptimizerCore.ts";
import { COST_EFFICIENCY_CRITERIA_PROPOSAL } from "../lib/autoCostEfficiencyReport.ts";
import {
  buildAutoCandidateMenu, buildCostEfficiencyManifest, costEfficiencyCallPlan, estimateAnswerMicroUsd,
} from "../lib/autoCostEfficiencyPlan.ts";
import { gradeDevelopmentAnswer, parseDevelopmentCorpus, canonicalBenchmarkJson } from "../lib/routerDevelopmentBenchmark.ts";
import { autoQualityCostCases } from "../tests/fixtures/autoQualityCostCases.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AT = "2026-11-23T00:00:00.000Z";
const SOURCE_PATHS = [
  "scripts/auto-cost-efficiency-dry-run.mjs", "lib/autoRouterOptimizerCore.ts", "lib/autoCostEfficiencyReport.ts",
  "lib/autoCostEfficiencyPlan.ts", "lib/autoOptimizerCost.ts", "lib/providerUsageCost.ts", "lib/modelPricing.ts", "lib/models.ts",
  "tests/fixtures/autoQualityCostCases.mjs", "docs/ops/router-development-benchmark/development-v1.json",
].sort();
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const git = (args) => { try { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); } catch { return null; } };

/** The tool-free fixtures (tool-contract cases need a Chat E2E) and the exact-answer development corpus. */
export function costEfficiencyCorpus() {
  const fixtures = autoQualityCostCases.filter((item) => !item.toolContractOnly).map((item) => ({
    id: `fixture-${item.id}`, family: `fixture-${item.kind}`, kind: item.kind, routerInput: item.prompt, routerContext: item.previousAnswer,
    constraint: item.constraint,
  }));
  const corpus = parseDevelopmentCorpus(readFileSync(resolve(root, "docs/ops/router-development-benchmark/development-v1.json"), "utf8"));
  const exact = corpus.cases.map((item) => ({
    id: item.id, family: item.id.replace(/^dev-(ko|en)-/, "dev-"), kind: item.task, routerInput: item.prompt, routerContext: null, expected: item,
  }));
  // Interleaved so that the sample cap drops from both sources, not one.
  const merged = [];
  for (let index = 0; index < Math.max(fixtures.length, exact.length); index += 1) {
    if (fixtures[index]) merged.push(fixtures[index]);
    if (exact[index]) merged.push(exact[index]);
  }
  return { cases: merged, digest: sha(canonicalBenchmarkJson(merged.map(({ expected, ...rest }) => ({ ...rest, expected: expected?.expected ?? null })))) };
}

const priceOf = (model, inputTokens, outputTokens, usage = {}) => {
  const pricing = resolveModelPricing(model, { estimatedPromptTokens: inputTokens });
  return optimizerCostFields(observeOptimizerUsageCost({ inputTokens, outputTokens, ...usage }, {
    inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens, outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
    cachedInputPriceMultiplier: pricing.cachedInputPriceMultiplier, cacheWriteUsdPerMillionTokens: pricing.cacheWriteUsdPerMillionTokens ?? null,
  }));
};
const tokensOf = (text) => preflightInputEstimate([{ role: "user", content: text }]).estimatedInputTokens;

export async function runCostEfficiencyDryRun({ optimizerModelId = DEFAULT_MODEL_ID, routerModelId = DEFAULT_MODEL_ID } = {}) {
  if (Object.keys(process.env).some((key) => /^CHAT_MODEL_.*_(INPUT_USD_PER_MILLION|OUTPUT_USD_PER_MILLION|CACHED_INPUT_PRICE_MULTIPLIER|MAX_OUTPUT_TOKENS|RESERVATION_OUTPUT_TOKENS)$/i.test(key)))
    throw new Error("dry_run_pricing_environment_overrides");
  const models = AVAILABLE_MODELS.filter((model) => model.enabled && !model.catalogDeleted);
  const byId = new Map(models.map((model) => [model.id, model]));
  const optimizer = byId.get(optimizerModelId);
  const router = byId.get(routerModelId);
  if (!optimizer || !router) throw new Error("dry_run_unknown_model");
  const menuFor = buildAutoCandidateMenu({
    models, plan: "Max", requestedModelId: DEFAULT_MODEL_ID, searchBackendReadiness: NO_WEB_SEARCH_BACKENDS,
    unhealthyModelIds: undefined, signals: undefined,
  });
  const { cases, digest } = costEfficiencyCorpus();
  const decisions = cases.flatMap((item) => {
    const candidates = menuFor(item.routerInput);
    return candidates.length < 2 ? [] : [{
      id: item.id, family: item.family, taskKind: item.kind, routerInput: item.routerInput, routerContext: item.routerContext,
      routerSession: null, candidates, pickedModelId: null, reason: null, ...(item.expected ? { expected: item.expected } : {}),
    }];
  });
  const split = splitOptimizerDecisionsByFamily(decisions, (decision) => decision.family);
  const familiesOf = (items) => new Set(items.map((item) => item.family)).size;
  const dearest = (candidates) => [...candidates].sort((a, b) => (b.credits ?? 0) - (a.credits ?? 0) || a.id.localeCompare(b.id))[0]?.id ?? null;
  const cheapest = (candidates) => [...candidates].sort((a, b) => (a.credits ?? 0) - (b.credits ?? 0) || a.id.localeCompare(b.id))[0]?.id ?? null;
  const MOCK_GUIDANCE = "Send short factual, extraction and format work to a lower-credit candidate.\nKeep multi-step reasoning on a higher tier.";
  const SIMPLE = /short|translation|extraction|format|follow-up/;
  const lowestCredit = (decision) => Math.min(...decision.candidates.map((candidate) => candidate.credits ?? Infinity));
  const result = await runOptimizerCycle({
    decisions, incumbentGuidance: AUTO_LLM_ROUTER_DEFAULT_GUIDANCE, objective: "chat_cost_efficiency",
    criteria: COST_EFFICIENCY_CRITERIA_PROPOSAL, familyOf: (decision) => decision.family ?? decision.id,
  }, {
    budgetMicroUsd: AUTO_ROUTER_OPTIMIZER_RUN_CAP_MICRO_USD,
    candidatesFor: menuFor,
    synthesize: async () => ({ value: { messages: [] }, ...priceOf(optimizer, 200, 200), provider: optimizer.provider }),
    generate: async (message) => ({ value: { findings: [], recommendations: [], guidance: MOCK_GUIDANCE, settingChanges: [] },
      ...priceOf(optimizer, tokensOf(message), 400), provider: optimizer.provider }),
    // Mock router: the frozen baseline overpays; the mock proposal moves simple work down.
    route: async (guidance, decision) => ({
      value: guidance === MOCK_GUIDANCE && SIMPLE.test(decision.taskKind ?? "") ? cheapest(decision.candidates) : dearest(decision.candidates),
      ...priceOf(router, tokensOf(decision.routerInput) + 1_500, 40), provider: router.provider,
    }),
    // Mock answers: every model meets the fixture's constraint; the lowest-credit tier gets calculations wrong.
    answer: async (modelId, turn) => {
      const model = byId.get(modelId);
      const decision = decisions.find((item) => item.routerInput === turn.message);
      const weak = decision && (decision.candidates.find((item) => item.id === modelId)?.credits ?? 0) <= lowestCredit(decision);
      const expected = decision?.expected?.expected;
      const text = expected
        ? JSON.stringify(weak && decision.taskKind === "grounded-calculation" ? { ...expected, __mock_wrong__: true } : expected)
        : `mock answer honouring: ${cases.find((item) => item.id === decision?.id)?.constraint ?? "the request"}`;
      return { value: text, ...priceOf(model, tokensOf(turn.message), 200 + (model.reasoning ? 300 : 0)), provider: model.provider };
    },
    judge: async () => { throw new Error("price_aware_judge_not_used"); },
    // Mock judge: equal unless exactly one answer is malformed JSON for a JSON case.
    qualityJudge: async (message) => {
      const { answerA, answerB } = JSON.parse(message);
      const wrong = (text) => text.includes("__mock_wrong__");
      const quality = wrong(answerA) === wrong(answerB) ? "equal" : wrong(answerA) ? "B" : "A";
      return { value: { quality, constraintFailure: { A: wrong(answerA), B: wrong(answerB) } },
        ...priceOf(optimizer, tokensOf(message) + 600, 60), provider: optimizer.provider };
    },
    estimateAnswerMicroUsd: (modelId, decision) => estimateAnswerMicroUsd(byId.get(modelId), decision),
    gradeExact: (decision, answer) => (decision.expected ? gradeDevelopmentAnswer(decision.expected, answer).pass : null),
  });
  const sample = Math.min(decisions.length, AUTO_ROUTER_OPTIMIZER_SAMPLE_MAX);
  const manifest = buildCostEfficiencyManifest({
    createdAt: AT,
    source: {
      commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain", "--", ...SOURCE_PATHS]) ? true : false,
      files: Object.fromEntries(SOURCE_PATHS.map((path) => [path, sha(readFileSync(resolve(root, path), "utf8"))])),
    },
    execution: "mock",
    location: "local PC; no provider, database or network",
    baselineGuidance: AUTO_LLM_ROUTER_DEFAULT_GUIDANCE,
    optimizerModel: optimizer, routerModel: router, answerModels: models,
    corpus: {
      source: "tests/fixtures/autoQualityCostCases.mjs (tool-free only) + docs/ops/router-development-benchmark/development-v1.json",
      cases: sample, train: split.train.length, evaluate: split.evaluate.length,
      split: "family: fixture kind (KO/EN together); development case number (KO/EN together)",
      families: { train: familiesOf(split.train), evaluate: familiesOf(split.evaluate) }, digest,
    },
    criteria: COST_EFFICIENCY_CRITERIA_PROPOSAL,
    plan: costEfficiencyCallPlan({
      evaluate: split.evaluate.length, trainRoutes: 0, synthesize: false,
      optimizer: resolveModelPricing(optimizer), router: resolveModelPricing(router), answerModels: models,
    }),
    runCapMicroUsd: AUTO_ROUTER_OPTIMIZER_RUN_CAP_MICRO_USD,
    resultLocation: "--output file (mock); AutoRouterOptimizerCycle.summary for a live run",
  });
  return {
    notice: "MOCK: code-behaviour check only. Not model quality, not a saving, not statistical non-inferiority.",
    manifest,
    result: { status: result.status, failure: result.failure, spentMicroUsd: result.spentMicroUsd, costEfficiency: result.costEfficiency },
  };
}

async function main() {
  const output = process.argv.slice(2).find((arg) => arg.startsWith("--output="))?.slice("--output=".length);
  const optimizerModelId = process.argv.slice(2).find((arg) => arg.startsWith("--optimizer-model="))?.slice(18);
  const routerModelId = process.argv.slice(2).find((arg) => arg.startsWith("--router-model="))?.slice(15);
  const run = await runCostEfficiencyDryRun({ ...(optimizerModelId ? { optimizerModelId } : {}), ...(routerModelId ? { routerModelId } : {}) });
  const text = `${JSON.stringify(run, null, 2)}\n`;
  if (output) {
    if (existsSync(output)) throw new Error("dry_run_output_exists");
    writeFileSync(output, text, { flag: "wx" });
  }
  const c = run.result.costEfficiency.candidateDiagnosis;
  console.log(JSON.stringify({
    notice: run.notice, status: run.result.status, failure: run.result.failure,
    corpus: run.manifest.corpus, plannedCalls: run.manifest.plan.calls, worstCaseMicroUsd: run.manifest.plan.worstCaseMicroUsd,
    worstCaseByKind: run.manifest.plan.worstCaseByKind, bindingRunCapMicroUsd: run.manifest.stop.runCapMicroUsd,
    savingsSamples: c.savingsSamples, quality: c.quality, criticalRegressions: c.criticalRegressions, exact: c.exact,
    mockSpentMicroUsd: run.result.spentMicroUsd, applicability: run.result.costEfficiency.applicability, output: output ?? null,
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
