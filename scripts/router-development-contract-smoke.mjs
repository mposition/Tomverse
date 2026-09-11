// Fixed offline mock. No live switch, provider adapter import, credentials or network operation.
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "../lib/models.ts";
import { benchmarkDigest, canonicalBenchmarkJson, parseDevelopmentCorpus, scoreDevelopmentResults } from "../lib/routerDevelopmentBenchmark.ts";
import { buildDevelopmentPlan } from "../lib/routerDevelopmentBenchmarkPlan.ts";
import { buildCollectionManifest, COLLECTION_VERSION, COLLECTION_ASSUMPTIONS, emptyCollectionObservation } from "../lib/routerDevelopmentCollector.ts";
import { collectDevelopment, collectorPaths, exportDevelopmentCollection, replayCollectionJournal } from "../lib/routerDevelopmentCollectorJournal.ts";
import { replayDevelopment } from "../lib/routerDevelopmentReplay.ts";
import { REPLAY_COLLECTOR_SOURCE_PATHS } from "../lib/routerDevelopmentReplaySource.ts";
import { buildDevelopmentExecutionObservation, collectionExecutionContracts, validateExecutionObservationSet, executionObservationCompatibility, legacyExecutionObservationStatus } from "../lib/routerDevelopmentExecution.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AT = "2026-09-11T00:00:00.000Z";
const now = () => Date.parse(AT);
const caseIds = ["dev-en-calc-01", "dev-en-extract-01", "dev-ko-calc-01", "dev-ko-extract-01"];
const selectedModels = [DEFAULT_MODEL_ID, "deepseek-v4-flash"];
const hash = (value) => benchmarkDigest(canonicalBenchmarkJson(value));
const sourcePaths = [...new Set([...REPLAY_COLLECTOR_SOURCE_PATHS,
  "lib/routerDevelopmentExecution.ts", "lib/routerDevelopmentReplay.ts", "lib/routerDevelopmentReplaySource.ts",
  "scripts/router-development-contract-smoke.mjs", "docs/ops/router-development-benchmark/development-v1.json",
])].sort();

function approvalFor(manifest, suffix) {
  return { schemaVersion: COLLECTION_VERSION, status: "approved", approvalId: `mock-only-${suffix}`,
    manifestDigest: manifest.manifestDigest, approvedBy: "SYNTHETIC MOCK ONLY; NOT HUMAN SPENDING AUTHORIZATION",
    approvedAt: AT, expiresAt: manifest.limits.expiresAt, acknowledgements: [...COLLECTION_ASSUMPTIONS] };
}
function returned(answerText, finish = "stop") {
  return { status: "returned", answerText, answerBytes: Buffer.byteLength(answerText), answerDigest: benchmarkDigest(answerText),
    textOmitted: false, completeResponse: true, failureCode: null, latencyMs: null,
    observation: { ...emptyCollectionObservation(), source: "provider_body_allowlist", finish } };
}
function failure() {
  return { status: "failed", answerText: null, answerBytes: null, answerDigest: null, textOmitted: false,
    completeResponse: true, failureCode: "mock_provider_error", latencyMs: null, observation: emptyCollectionObservation() };
}
function readState(directory, manifest, approval) {
  return replayCollectionJournal(readFileSync(collectorPaths(directory, approval.approvalId).ledger, "utf8"), manifest, approval);
}
function observationsFor(state, contracts) {
  return state.entries.filter((entry) => entry.event.kind === "terminal").map((entry) => {
    const contract = contracts.find((contract) => contract.rowId === entry.event.rowId);
    return buildDevelopmentExecutionObservation({ executionDigest: contract.contractDigest, rowId: contract.rowId,
      recordedAt: entry.event.at, provenance: "mock-only", journalEntryDigest: entry.entryDigest, outcome: entry.event.outcome });
  });
}

export async function runExecutionContractSmoke({ outputDirectory = null } = {}) {
  if (Object.keys(process.env).some((key) => /^CHAT_MODEL_.*_(INPUT_USD_PER_MILLION|OUTPUT_USD_PER_MILLION|CACHED_INPUT_PRICE_MULTIPLIER|MAX_OUTPUT_TOKENS|RESERVATION_OUTPUT_TOKENS)$/i.test(key))) throw new Error("mock_environment_overrides_unsupported");
  const files = Object.fromEntries(sourcePaths.map((path) => [path, benchmarkDigest(readFileSync(resolve(root, path), "utf8"))]));
  const implementationSource = { commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain", "--", ...sourcePaths], { cwd: root, encoding: "utf8" }).trim().length > 0, files };
  // The old collector's frozen-source gate is exercised with a plainly synthetic source.
  // This is not the checkout HEAD, a real observation source or a reusable paid manifest.
  const fixtureSource = { commit: "0".repeat(40), dirty: false, files: { "synthetic-mock-implementation": hash(files) } };
  const corpusText = readFileSync(resolve(root, "docs/ops/router-development-benchmark/development-v1.json"), "utf8");
  const corpus = parseDevelopmentCorpus(corpusText);
  const plan = buildDevelopmentPlan({ corpus, models: AVAILABLE_MODELS, source: fixtureSource, createdAt: AT, plan: "Pro", requestedModelId: DEFAULT_MODEL_ID });
  const selected = plan.rows.filter((row) => caseIds.includes(row.caseId) && selectedModels.includes(row.modelId) && row.benchmarkEligibility.eligible);
  if (selected.length !== 8) throw new Error("mock_expected_eight_selected_rows");
  const manifest = buildCollectionManifest({ plan, models: AVAILABLE_MODELS, collectorSource: fixtureSource,
    selectedRowIds: selected.map((row) => row.rowId),
    limits: { maxTotalMicroUsd: 1_000_000_000, maxRequestMicroUsd: 1_000_000_000, maxCalls: 8,
      requestTimeoutMs: 1000, runTimeoutMs: 60000, expiresAt: "2026-09-11T01:00:00.000Z" } });
  if (!manifest.completionPossibleWithinLimits) throw new Error("mock_fixture_limits_no_longer_fit");
  const contracts = collectionExecutionContracts({ corpus, models: AVAILABLE_MODELS, manifest, benchmarkSource: fixtureSource, collectorSource: fixtureSource });
  // Exclusive directory creation occurs before any mock collection and never uses real Git common-dir.
  const directory = outputDirectory === null ? mkdtempSync(join(tmpdir(), "router-contract-smoke-")) : resolve(outputDirectory);
  if (outputDirectory !== null) mkdirSync(directory);
  try {
    const approval = approvalFor(manifest, "main");
    const calls = [];
    const assertCurrent = () => {
      for (const path of sourcePaths) if (benchmarkDigest(readFileSync(resolve(root, path), "utf8")) !== files[path]) throw new Error("mock_source_changed_during_run");
    };
    const adapter = async (request) => {
      if (Object.keys(request).sort().join(",") !== "maxOutputTokens,modelId,prompt,settings,signal") throw new Error("mock_request_envelope_changed");
      const call = manifest.calls.find((call) => {
        const row = plan.rows.find((row) => row.rowId === call.rowId);
        return row.modelId === request.modelId && row.input.prompt === request.prompt;
      });
      if (!call || request.maxOutputTokens !== call.reserve.outputCapTokens || hash(request.settings) !== hash(call.settings)) throw new Error("mock_request_contract_mismatch");
      if (calls.includes(call.rowId)) throw new Error("mock_duplicate_dispatch");
      calls.push(call.rowId);
      const index = manifest.calls.indexOf(call);
      const row = plan.rows.find((row) => row.rowId === call.rowId);
      // Gold is used only by this fixed synthetic stub, after verifying the model-facing request.
      const gold = JSON.stringify(corpus.cases.find((item) => item.id === row.caseId).expected);
      return index === 1 ? returned("{}") : index === 2 ? returned("  ") : index === 3 ? returned("not-json") : index === 4 ? failure() : returned(gold);
    };
    const input = { manifest, approval, commonDir: directory, now, assertCurrent, adapter };
    let terminalCount = 0;
    try {
      await collectDevelopment({ ...input, onCheckpoint(point) {
        if (point === "terminal_durable" && ++terminalCount === 2) throw new Error("mock_interrupt_after_two_terminals");
      } });
      throw new Error("mock_interruption_not_observed");
    } catch (error) { if (error.message !== "mock_interrupt_after_two_terminals") throw error; }
    const interrupted = readState(directory, manifest, approval);
    const collected = await collectDevelopment(input);
    const beforeReplay = calls.length;
    await collectDevelopment(input);
    if (calls.length !== beforeReplay || calls.length !== 8) throw new Error("mock_resume_dispatch_count");
    const journalText = readFileSync(collectorPaths(directory, approval.approvalId).ledger, "utf8");
    const state = replayCollectionJournal(journalText, manifest, approval);
    const observations = observationsFor(state, contracts);
    const compatible = validateExecutionObservationSet(observations, contracts, { journalText, manifest, approval });
    if (compatible.some((entry) => entry.compatibility.disposition !== "compatible")) throw new Error("mock_compatible_fixture_held");
    const exported = await exportDevelopmentCollection(input);
    // v1 export has no mock origin; normalize only this NEW mock fixture, preserving all identities/answers.
    // Local journal times are not provider observations. No historical observation is read or rewritten.
    const answers = { ...exported, origin: { kind: "synthetic-fixture", description: "Fixed offline mock adapter only; no provider calls, measured timings, usage or spending." },
      rows: exported.rows.map((row) => ({ ...row, recordedAt: null, providerResponseId: null, modelVersion: null,
        metrics: { inputTokens: null, outputTokens: null, latencyMs: null, providerCostUsd: null } })) };
    const score = scoreDevelopmentResults(corpus, plan, answers);
    const candidate = { schemaVersion: "router-development-replay-policy-v1", purpose: "development-only", policyId: "mock-default-control-v1",
      preferences: { general: [DEFAULT_MODEL_ID] }, fallback: "original-router" };
    const replay = replayDevelopment({ corpus, corpusText, models: AVAILABLE_MODELS, manifest, answers, candidate,
      observationSource: { benchmark: fixtureSource, collector: fixtureSource, corpusFileDigest: benchmarkDigest(corpusText) }, replaySource: implementationSource });

    const heldApproval = approvalFor(manifest, "unknown");
    let heldAdapterCalls = 0;
    const heldInput = { ...input, approval: heldApproval, adapter: async () => { heldAdapterCalls++; throw new Error("mock_held_dispatch_forbidden"); } };
    try { await collectDevelopment({ ...heldInput, onCheckpoint(point) { if (point === "intent_durable") throw new Error("mock_interrupt_after_intent"); } }); }
    catch (error) { if (error.message !== "mock_interrupt_after_intent") throw error; }
    const held = await collectDevelopment(heldInput);
    let heldExportRefused = false;
    try { await exportDevelopmentCollection(heldInput); } catch (error) { if (error.message !== "collector_export_uncertain_or_unsupported") throw error; heldExportRefused = true; }
    if (heldAdapterCalls || !heldExportRefused || held.stopReason !== "unknown_after_dispatch") throw new Error("mock_unknown_not_held");
    const incomplete = buildDevelopmentExecutionObservation({ executionDigest: contracts[0].contractDigest, rowId: contracts[0].rowId,
      recordedAt: AT, provenance: "mock-only", journalEntryDigest: hash("synthetic-incomplete"), outcome: returned("{}", "length") });
    const incompleteCompatibility = executionObservationCompatibility({ expected: contracts[0], observed: contracts[0], observation: incomplete });
    if (incompleteCompatibility.disposition !== "hold") throw new Error("mock_incomplete_not_held");
    const report = {
      schemaVersion: "router-development-contract-smoke-v2", purpose: "development-only", evidenceStatus: "mock_validation_only",
      providerCalls: 0, incurredProviderSpendUsd: 0, implementationSource,
      fixtureSource, simulatedClock: AT, manifestDigest: manifest.manifestDigest,
      mockCollection: { selectedRows: 8, adapterCalls: calls.length, interruptedTerminalRecords: [...interrupted.attempts.values()].filter((attempt) => attempt.terminal !== null).length,
        finalTerminalRecords: [...state.attempts.values()].filter((attempt) => attempt.terminal !== null).length, repeatedCompletedCalls: calls.length - beforeReplay,
        outcome: collected.stopReason, simulatedReservationMicroUsd: state.totalReservedMicroUsd, actualInvoiceMicroUsd: null },
      uncertainRecovery: { stopReason: held.stopReason, adapterCalls: heldAdapterCalls, dispatchIntents: held.dispatchIntents,
        terminalRecords: held.terminalRecords, exportRefused: heldExportRefused, unknownRows: held.unknownRows },
      incompleteResponse: incompleteCompatibility,
      legacyImportWithoutJournal: legacyExecutionObservationStatus(answers, plan),
      compatibility: compatible.map(({ rowId, observation, compatibility }) => ({ rowId, provenance: observation?.provenance ?? null, ...compatibility })),
      metricCoverage: { observedRows: observations.length, measuredTtftRows: 0, ttftMs: null, measuredEndToEndRows: 0, endToEndLatencyMs: null,
        measuredBilledCostRows: 0, providerBilledCostUsd: null },
      score, replay, productExecutionVerified: false,
      limitations: ["Fixed synthetic stub; correctness categories verify plumbing, not model quality.",
        "This is the execution-contract slice only; no v2 corpus, paid proposal, model ranking or production adoption.",
        "Synthetic manifest/approval/clock are mock inputs only and cannot authorize a real run.",
        "Context and complete-generation receipts missing from legacy v1 answers must not be invented.",
        "Source digests cover an explicit local list, not an authenticated or complete transitive runtime capture."],
    };
    if (outputDirectory !== null) {
      for (const [name, value] of Object.entries({ "MOCK-ONLY.json": { evidenceStatus: report.evidenceStatus, providerCalls: 0, approval: "not-human-authorization" },
        "manifest.mock.json": manifest, "contracts.mock.json": contracts, "observations.mock.json": observations, "answers.mock.json": answers, "report.json": report })) {
        writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      }
    }
    return report;
  } finally {
    if (outputDirectory === null) {
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("router-contract-smoke-")) throw new Error("mock_cleanup_scope");
      rmSync(target, { recursive: true });
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Fixed offline mock; no credentials or provider calls.\nnpm run benchmark:router:contract-smoke -- [--output-dir=NEW_DIRECTORY]\nNo flag prints a content-free report and removes its own temporary mock journal. Output directory must be new with an existing parent; generated mocks are not paid-run authority.");
    return;
  }
  if (args.length > 1 || (args.length && !/^--output-dir=.+$/.test(args[0]))) throw new Error("mock_unknown_argument_no_live_mode");
  const report = await runExecutionContractSmoke({ outputDirectory: args[0]?.slice("--output-dir=".length) ?? null });
  console.log(JSON.stringify(args.length ? { evidenceStatus: report.evidenceStatus, providerCalls: 0,
    populationRows: report.score.summary.catalogueRows, selectedRows: report.mockCollection.selectedRows,
    mockAdapterCalls: report.mockCollection.adapterCalls, scoreSummary: report.score.summary,
    unknownRecovery: report.uncertainRecovery.stopReason, report: resolve(args[0].slice("--output-dir=".length), "report.json") } : report, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const safe = typeof error.message === "string" && /^[a-z0-9_]{1,120}$/.test(error.message) ? error.message : "mock_operation_failed";
    console.error(JSON.stringify({ error: safe })); process.exitCode = 1;
  });
}
