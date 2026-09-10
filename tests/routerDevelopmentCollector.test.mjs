import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "../lib/models.ts";
import { parseDevelopmentCorpus, canonicalBenchmarkJson, scoreDevelopmentResults } from "../lib/routerDevelopmentBenchmark.ts";
import { buildDevelopmentPlan } from "../lib/routerDevelopmentBenchmarkPlan.ts";
import { buildCollectionManifest, COLLECTION_ASSUMPTIONS, COLLECTION_SUPPORTED_PROVIDERS, COLLECTION_VERSION, emptyCollectionObservation, isCollectionProviderSupported, validateCollectionApproval } from "../lib/routerDevelopmentCollector.ts";
import { collectDevelopment, collectorPaths, exportDevelopmentCollection, replayCollectionJournal } from "../lib/routerDevelopmentCollectorJournal.ts";
import { collectionReturnedOutcome } from "../lib/routerDevelopmentCollectorProvider.ts";

const temporary = mkdtempSync(join(tmpdir(), "collector-core-test-"));
after(() => { const target = resolve(temporary); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith("collector-core-test-")); rmSync(target, { recursive: true }); });
const corpus = parseDevelopmentCorpus(readFileSync(new URL("../docs/ops/router-development-benchmark/development-v1.json", import.meta.url), "utf8"));
const at = "2026-09-10T00:00:00.000Z";
const now = () => Date.parse(at);
const source = { commit: "a".repeat(40), dirty: false, files: { "synthetic-test": "b".repeat(64) } };
const plan = buildDevelopmentPlan({ corpus, models: AVAILABLE_MODELS, source, createdAt: at, plan: "Pro", requestedModelId: DEFAULT_MODEL_ID });
const eligible = plan.rows.filter((row) => row.benchmarkEligibility.eligible);
const limits = { maxTotalMicroUsd: 1_000_000_000, maxRequestMicroUsd: 1_000_000_000, maxCalls: 1008, requestTimeoutMs: 1000, runTimeoutMs: 60000, expiresAt: "2026-09-10T01:00:00.000Z" };
const manifestFor = (rows, overrides = {}) => buildCollectionManifest({ plan, models: AVAILABLE_MODELS, collectorSource: source, selectedRowIds: rows.map((row) => row.rowId), limits: { ...limits, ...overrides } });
const approvalFor = (manifest, approvalId) => ({ schemaVersion: COLLECTION_VERSION, status: "approved", approvalId, manifestDigest: manifest.manifestDigest, approvedBy: "SYNTHETIC TEST; NOT HUMAN AUTHORIZATION", approvedAt: at, expiresAt: manifest.limits.expiresAt, acknowledgements: [...COLLECTION_ASSUMPTIONS] });

test("full 42x24 manifest stays within existing JSON byte and node limits", () => {
  const manifest = manifestFor(eligible, { maxTotalMicroUsd: 1_000_000_000_000, maxRequestMicroUsd: 1_000_000_000_000 });
  const text = canonicalBenchmarkJson(manifest);
  assert.ok(Buffer.byteLength(text) < 16_777_216);
  assert.equal(manifest.plan.rows.length, 1008);
  assert.equal(manifest.calls.length, 360);
  assert.equal(manifest.plan.summary.refusedRows, 648);
  assert.equal(manifest.status, "proposal");
  assert.equal(manifest.completionPossibleWithinLimits, true);
  assert.throws(() => validateCollectionApproval(manifest, manifest, now()));
  assert.equal(new Set(eligible.map((row) => row.modelId)).size, 15);
  assert.ok(eligible.every((row) => isCollectionProviderSupported(row.provider)));
});

test("a new catalogue context window cannot silently admit an unparsed provider family", () => {
  assert.deepEqual(COLLECTION_SUPPORTED_PROVIDERS, ["openai", "deepseek", "xai", "mistral", "moonshot", "anthropic", "minimax", "google"]);
  for (const provider of ["qwen", "groq", "zhipu", "perplexity", "OpenAI", "openai ", "unknown", ""]) assert.equal(isCollectionProviderSupported(provider), false);
  // Only this in-memory fixture gains a context window; the real catalogue and plan remain unchanged.
  const models = AVAILABLE_MODELS.map((model) => model.id === "qwen3.7-max" ? { ...model, contextWindowTokens: 1_000_000 } : model);
  const futurePlan = buildDevelopmentPlan({ corpus, models, source, createdAt: at, plan: "Pro", requestedModelId: DEFAULT_MODEL_ID });
  const selected = futurePlan.rows.find((row) => row.modelId === "qwen3.7-max" && row.benchmarkEligibility.eligible);
  assert.ok(selected, "the fixture must pass the original static benchmark admission");
  assert.equal(futurePlan.rows.length, 1008);
  assert.throws(() => buildCollectionManifest({ plan: futurePlan, models, collectorSource: source, selectedRowIds: [selected.rowId], limits }), /collector_provider_family_unsupported/);
  assert.equal(plan.rows.filter((row) => row.benchmarkEligibility.eligible).length, 360);
  assert.equal(plan.rows.filter((row) => !row.benchmarkEligibility.eligible).length, 648);
});

test("unavailable unsupported-provider observations remain held and block resume and export", async () => {
  const manifest = manifestFor(eligible.slice(0, 2));
  const approval = approvalFor(manifest, "core-unsupported-provider");
  let calls = 0;
  const input = { manifest, approval, commonDir: temporary, now, assertCurrent() {}, adapter: async () => {
    calls++;
    return collectionReturnedOutcome("qwen", {}, "{}", 1);
  } };
  const report = await collectDevelopment(input);
  assert.equal(report.stopReason, "measurement_or_execution_unknown");
  assert.equal(report.terminalRecords, 1);
  assert.equal(report.committedReservationMicroUsd, manifest.calls[0].reserve.reservedMicroUsd);
  assert.equal(report.rows.length, 1008);
  assert.equal(report.rows.filter((row) => row.outcome === "not_run").length, 359);
  await collectDevelopment(input);
  assert.equal(calls, 1);
  await assert.rejects(exportDevelopmentCollection(input), /collector_export_uncertain_or_unsupported/);
});

test("permanent reservations stop a selected population explicitly and completed rows never rerun", async () => {
  const manifest = manifestFor(eligible.slice(0, 2), { maxCalls: 1 });
  assert.equal(manifest.completionPossibleWithinLimits, false);
  const approval = approvalFor(manifest, "core-budget-stop");
  const requests = [];
  const adapter = async (request) => { requests.push(request); return collectionReturnedOutcome("openai", {}, "{}", 5); };
  const input = { manifest, approval, commonDir: temporary, now, assertCurrent() {}, adapter };
  const report = await collectDevelopment(input);
  assert.equal(report.stopReason, "budget_stopped");
  assert.equal(report.dispatchIntents, 1);
  assert.equal(report.terminalRecords, 1);
  assert.equal(report.actualInvoiceMicroUsd, null);
  assert.equal(report.rows.length, 1008);
  assert.equal(report.rows.filter((row) => row.outcome === "not_run").length, 359);
  assert.deepEqual(Object.keys(requests[0]).sort(), ["modelId", "prompt", "maxOutputTokens", "settings", "signal"].sort());
  assert.equal(requests[0].prompt, plan.rows.find((row) => row.rowId === manifest.calls[0].rowId).input.prompt);
  assert.equal((await collectDevelopment(input)).committedReservationMicroUsd, report.committedReservationMicroUsd);
  assert.equal(requests.length, 1);
  const results = await exportDevelopmentCollection(input);
  assert.equal(results.rows[0].metrics.providerCostUsd, null);
  const score = scoreDevelopmentResults(corpus, plan, results);
  assert.equal(score.summary.notRun, 359);
  assert.equal(score.summary.correctnessRate, null);
});

test("confirmed blank and invalid JSON answers remain returned records for the frozen grader", async () => {
  const manifest = manifestFor(eligible.slice(0, 2));
  const approval = approvalFor(manifest, "core-blank-invalid");
  let calls = 0;
  const input = { manifest, approval, commonDir: temporary, now, assertCurrent() {}, adapter: async () => collectionReturnedOutcome("openai", {}, calls++ ? "not json" : "  ", 1) };
  await collectDevelopment(input);
  const score = scoreDevelopmentResults(corpus, plan, await exportDevelopmentCollection(input));
  assert.equal(score.summary.blank, 1);
  assert.equal(score.summary.invalidJson, 1);
  assert.equal(score.summary.submitted, 2);
  assert.equal(score.summary.notRun, 358);
});

test("unsupported billing on any terminal stops later rows and resume and refuses the whole export", async () => {
  const manifest = manifestFor(eligible.slice(0, 2));
  const approval = approvalFor(manifest, "core-error-tier-stop");
  let calls = 0;
  const input = { manifest, approval, commonDir: temporary, now, assertCurrent() {}, adapter: async () => {
    calls++;
    // Replay defends the observation even if an adapter incorrectly labels it ordinary failed.
    return { status: "failed", answerText: null, answerBytes: null, answerDigest: null, textOmitted: false, completeResponse: true,
      failureCode: "provider_http_error", latencyMs: 1, observation: { ...emptyCollectionObservation(), source: "provider_body_allowlist", servedProcessingTier: "priority", unsupportedBilling: true } };
  } };
  const report = await collectDevelopment(input);
  assert.equal(report.stopReason, "measurement_or_execution_unknown");
  assert.equal(calls, 1);
  assert.equal(report.rows.filter((row) => row.outcome === "not_run").length, 359);
  await collectDevelopment(input);
  assert.equal(calls, 1);
  await assert.rejects(exportDevelopmentCollection(input), /collector_export_uncertain_or_unsupported/);
});

for (const [name, counters] of [
  ["output_total", (inputBound, outputBound) => ({ outputTokens: outputBound + 1 })],
  ["input_total", (inputBound) => ({ inputTokens: inputBound + 1 })],
  ["input_partition_lower_bound", (inputBound) => ({ noCacheInputTokens: inputBound, cacheReadTokens: 1 })],
  ["reasoning_lower_bound", (inputBound, outputBound) => ({ reasoningTokens: outputBound + 1 })],
  ["safe_integer_cost_overflow", () => ({ inputTokens: Number.MAX_SAFE_INTEGER, noCacheInputTokens: Number.MAX_SAFE_INTEGER, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: Number.MAX_SAFE_INTEGER })],
]) test(`known ${name} breach stops with null cost and preserves the complete terminal evidence`, async () => {
  const manifest = manifestFor(eligible.filter((row) => row.modelId === DEFAULT_MODEL_ID).slice(0, 2));
  const approval = approvalFor(manifest, `core-bound-${name.replaceAll("_", "-")}`);
  const first = manifest.calls[0];
  const observation = { ...emptyCollectionObservation(), source: "provider_body_allowlist", ...counters(first.reserve.contextInputBoundAssumption, first.reserve.outputCapTokens) };
  const returned = { ...collectionReturnedOutcome("openai", {}, '{"preserve":"complete answer"}', 1), observation };
  let calls = 0;
  const input = { manifest, approval, commonDir: temporary, now, assertCurrent() {}, adapter: async () => { calls++; return returned; } };
  const report = await collectDevelopment(input);
  assert.equal(report.stopReason, "observed_token_bound_exceeded");
  assert.equal(calls, 1);
  assert.equal(report.dispatchIntents, 1);
  assert.equal(report.terminalRecords, 1);
  assert.equal(report.committedReservationMicroUsd, first.reserve.reservedMicroUsd);
  assert.equal(report.actualInvoiceMicroUsd, null);
  assert.equal(report.rows.length, 1008);
  assert.equal(report.rows.filter((row) => row.outcome === "not_run").length, 359);
  const state = replayCollectionJournal(readFileSync(collectorPaths(temporary, approval.approvalId).ledger, "utf8"), manifest, approval);
  const terminal = state.attempts.get(first.rowId).terminal;
  assert.equal(terminal.tokenUsageAtFrozenRatesMicroUsd, null);
  assert.deepEqual(terminal.outcome, returned);
  assert.equal(terminal.outcome.observation.cacheWriteTokens, observation.cacheWriteTokens);
  assert.equal((await collectDevelopment(input)).stopReason, "observed_token_bound_exceeded");
  assert.equal(calls, 1);
  await assert.rejects(exportDevelopmentCollection(input), /collector_export_uncertain_or_unsupported/);
});

test("known partition and reasoning values exactly at the bound do not invent missing totals or stop", async () => {
  const manifest = manifestFor(eligible.filter((row) => row.modelId === DEFAULT_MODEL_ID).slice(0, 2));
  const approval = approvalFor(manifest, "core-bound-equality");
  const reserve = manifest.calls[0].reserve;
  const observation = { ...emptyCollectionObservation(), source: "provider_body_allowlist", noCacheInputTokens: reserve.contextInputBoundAssumption - 1, cacheReadTokens: 1, reasoningTokens: reserve.outputCapTokens };
  let calls = 0;
  const input = { manifest, approval, commonDir: temporary, now, assertCurrent() {}, adapter: async () => { calls++; return { ...collectionReturnedOutcome("openai", {}, "{}", 1), observation }; } };
  assert.equal((await collectDevelopment(input)).stopReason, null);
  assert.equal(calls, 2);
  const state = replayCollectionJournal(readFileSync(collectorPaths(temporary, approval.approvalId).ledger, "utf8"), manifest, approval);
  for (const attempt of state.attempts.values()) {
    assert.equal(attempt.terminal.outcome.observation.inputTokens, null);
    assert.equal(attempt.terminal.outcome.observation.outputTokens, null);
    assert.equal(attempt.terminal.tokenUsageAtFrozenRatesMicroUsd, null);
  }
});
