// Fixed offline v2 fixture. No live switch, provider adapter, credential values or network calls.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "../lib/models.ts";
import { benchmarkDigest, canonicalBenchmarkJson, parseBenchmarkJson, DEVELOPMENT_LIMITS } from "../lib/routerDevelopmentBenchmark.ts";
import { parseDevelopmentCorpusV2, parseDevelopmentPartitionsV2, developmentCorpusV2Coverage } from "../lib/routerDevelopmentCorpusV2.ts";
import { buildDevelopmentPlanV2 } from "../lib/routerDevelopmentPlanV2.ts";
import { scoreDevelopmentResultsV2 } from "../lib/routerDevelopmentResultsV2.ts";
import { emptyCollectionObservation } from "../lib/routerDevelopmentCollector.ts";
import { collectDevelopment, collectorPaths, replayCollectionJournal } from "../lib/routerDevelopmentCollectorJournal.ts";
import { buildDevelopmentExecutionObservation, executionObservationCompatibility } from "../lib/routerDevelopmentExecution.ts";
import { REPLAY_COLLECTOR_SOURCE_PATHS } from "../lib/routerDevelopmentReplaySource.ts";
import { buildMockManifestV2, mockApprovalV2, collectionExecutionContractsV2, validateExecutionObservationSetV2,
  exportMockResultsV2, replayMockDevelopmentV2 } from "../lib/routerDevelopmentBridgeV2.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AT = "2026-09-11T00:00:00.000Z";
const now = () => Date.parse(AT);
const hash = (value) => benchmarkDigest(canonicalBenchmarkJson(value));
export const V2_BRIDGE_SOURCE_PATHS = [...new Set([...REPLAY_COLLECTOR_SOURCE_PATHS,
  "lib/routerDevelopmentCorpusV2.ts", "lib/routerDevelopmentPlanV2.ts", "lib/routerDevelopmentResultsV2.ts", "lib/routerDevelopmentBridgeV2.ts",
  "lib/routerDevelopmentExecution.ts", "lib/routerDevelopmentReplay.ts", "lib/routerDevelopmentReplaySource.ts",
  "scripts/router-development-v2-bridge.mjs", "docs/ops/router-development-benchmark/development-v2.json",
  "docs/ops/router-development-benchmark/development-v2-partitions.json",
])].sort();

function returned(answerText, finish = "stop") {
  return { status: "returned", answerText, answerBytes: Buffer.byteLength(answerText), answerDigest: benchmarkDigest(answerText),
    textOmitted: false, completeResponse: true, failureCode: null, latencyMs: null,
    observation: { ...emptyCollectionObservation(), source: "provider_body_allowlist", finish } };
}
function failure() {
  return { status: "failed", answerText: null, answerBytes: null, answerDigest: null, textOmitted: false,
    completeResponse: true, failureCode: "mock_provider_error", latencyMs: null, observation: emptyCollectionObservation() };
}
function artifactCapacity(value) {
  const text = canonicalBenchmarkJson(value);
  const parsed = parseBenchmarkJson(text);
  if (canonicalBenchmarkJson(parsed) !== text) throw new Error("bridge_v2_artifact_roundtrip");
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  parseBenchmarkJson(serialized);
  const count = (item) => 1 + (item && typeof item === "object" ? Object.values(item).reduce((total, child) => total + count(child), 0) : 0);
  return { bytes: Buffer.byteLength(text), serializedBytes: Buffer.byteLength(serialized), nodes: count(parsed), maxBytes: DEVELOPMENT_LIMITS.documentBytes, maxNodes: DEVELOPMENT_LIMITS.nodes };
}

export async function runV2Bridge({ outputDirectory = null } = {}) {
  if (Object.keys(process.env).some((key) => /^CHAT_MODEL_.*_(INPUT_USD_PER_MILLION|OUTPUT_USD_PER_MILLION|CACHED_INPUT_PRICE_MULTIPLIER|MAX_OUTPUT_TOKENS|RESERVATION_OUTPUT_TOKENS)$/i.test(key))) throw new Error("bridge_v2_environment_overrides_unsupported");
  const files = Object.fromEntries(V2_BRIDGE_SOURCE_PATHS.map((path) => [path, benchmarkDigest(readFileSync(resolve(root, path), "utf8"))]));
  const implementationSource = { commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain", "--", ...V2_BRIDGE_SOURCE_PATHS], { cwd: root, encoding: "utf8" }).trim().length > 0, files };
  // A protocol fixture source, never the implementation HEAD or a provider observation source.
  const fixtureSource = { commit: "0".repeat(40), dirty: false, files: { "synthetic-v2-mock-implementation": hash(files) } };
  const corpus = parseDevelopmentCorpusV2(readFileSync(resolve(root, "docs/ops/router-development-benchmark/development-v2.json"), "utf8"));
  const partitions = parseDevelopmentPartitionsV2(readFileSync(resolve(root, "docs/ops/router-development-benchmark/development-v2-partitions.json"), "utf8"), corpus);
  const context = { corpus, partitions, models: AVAILABLE_MODELS, benchmarkSource: fixtureSource, collectorSource: fixtureSource };
  const plan = buildDevelopmentPlanV2({ corpus, partitions, models: AVAILABLE_MODELS, source: fixtureSource, createdAt: AT, plan: "Pro", requestedModelId: DEFAULT_MODEL_ID });
  const selected = plan.rows.filter((row) => [DEFAULT_MODEL_ID, "deepseek-v4-flash"].includes(row.modelId) && row.benchmarkEligibility.eligible);
  if (selected.length !== 96 || new Set(selected.map((row) => row.caseId)).size !== 48) throw new Error("bridge_v2_expected_ninety_six_rows");
  const manifest = buildMockManifestV2({ ...context, plan, selectedRowIds: selected.map((row) => row.rowId),
    limits: { maxTotalMicroUsd: 100_000_000_000, maxRequestMicroUsd: 100_000_000_000, maxCalls: 96,
      requestTimeoutMs: 1000, runTimeoutMs: 60000, expiresAt: "2026-09-11T01:00:00.000Z" } });
  if (!manifest.collection.completionPossibleWithinLimits) throw new Error("bridge_v2_mock_limits_no_longer_fit");
  const contracts = collectionExecutionContractsV2({ ...context, manifest });
  const capacities = { plan: artifactCapacity(plan), manifest: artifactCapacity(manifest) };
  const directory = outputDirectory === null ? mkdtempSync(join(tmpdir(), "router-v2-bridge-")) : resolve(outputDirectory);
  if (outputDirectory !== null) mkdirSync(directory);
  try {
    const approval = mockApprovalV2(manifest);
    const calls = [];
    const assertCurrent = () => {
      for (const path of V2_BRIDGE_SOURCE_PATHS) if (benchmarkDigest(readFileSync(resolve(root, path), "utf8")) !== files[path]) throw new Error("bridge_v2_source_changed_during_run");
    };
    const adapter = async (request) => {
      if (Object.keys(request).sort().join(",") !== "maxOutputTokens,modelId,prompt,settings,signal") throw new Error("bridge_v2_request_envelope_changed");
      const row = selected.find((row) => row.modelId === request.modelId && row.input.prompt === request.prompt);
      const call = manifest.collection.calls.find((call) => call.rowId === row?.rowId);
      if (!row || !call || request.maxOutputTokens !== call.reserve.outputCapTokens || hash(request.settings) !== hash(call.settings)) throw new Error("bridge_v2_request_binding");
      if (calls.includes(row.rowId)) throw new Error("bridge_v2_duplicate_dispatch");
      calls.push(row.rowId);
      const index = manifest.collection.calls.indexOf(call);
      // Gold is read solely inside this fixed synthetic stub after the dispatch envelope check.
      const gold = JSON.stringify(corpus.cases.find((item) => item.id === row.caseId).expected);
      return index === 1 ? returned("{}") : index === 2 ? returned("  ") : index === 3 ? returned("not-json") : index === 4 ? failure() : returned(gold);
    };
    const input = { ...context, manifest: manifest.collection, mockManifest: manifest, approval, commonDir: directory, now, assertCurrent, adapter };
    let terminalCount = 0;
    try {
      await collectDevelopment({ ...input, onCheckpoint(point) { if (point === "terminal_durable" && ++terminalCount === 2) throw new Error("bridge_v2_interrupt_after_two_terminals"); } });
      throw new Error("bridge_v2_interruption_missing");
    } catch (error) { if (error.message !== "bridge_v2_interrupt_after_two_terminals") throw error; }
    const readJournal = () => readFileSync(collectorPaths(directory, approval.approvalId).ledger, "utf8");
    const interrupted = replayCollectionJournal(readJournal(), manifest.collection, approval);
    const beforeResume = calls.length;
    const collected = await collectDevelopment(input);
    const recoveredRows = calls.length - beforeResume;
    const beforeRepeat = calls.length;
    await collectDevelopment(input);
    if (calls.length !== 96 || beforeRepeat !== calls.length || recoveredRows !== 94) throw new Error("bridge_v2_resume_count");
    const journalText = readJournal();
    const journal = replayCollectionJournal(journalText, manifest.collection, approval);
    const observations = journal.entries.filter((entry) => entry.event.kind === "terminal").map((entry) => {
      const contract = contracts.find((contract) => contract.rowId === entry.event.rowId);
      return buildDevelopmentExecutionObservation({ executionDigest: contract.contractDigest, rowId: contract.rowId,
        recordedAt: entry.event.at, provenance: "mock-only", journalEntryDigest: entry.entryDigest, outcome: entry.event.outcome });
    });
    const compatible = validateExecutionObservationSetV2(observations, contracts, { ...context, manifest, approval, journalText });
    if (compatible.some((entry) => entry.compatibility.disposition !== "compatible")) throw new Error("bridge_v2_mock_held");
    const partial = validateExecutionObservationSetV2(observations.slice(0, 2), contracts, { ...context, manifest, approval, journalText });
    const answers = await exportMockResultsV2(input);
    const score = scoreDevelopmentResultsV2(corpus, partitions, plan, answers);
    const candidate = { schemaVersion: "router-development-replay-policy-v1", purpose: "development-only", policyId: "mock-v2-default-control",
      preferences: { general: [DEFAULT_MODEL_ID] }, fallback: "original-router" };
    const replay = replayMockDevelopmentV2({ ...context, manifest, answers, candidate, replaySource: implementationSource,
      contracts, observations, journalText, approval });
    const heldApproval = mockApprovalV2(manifest, "unknown");
    let heldAdapterCalls = 0;
    const heldInput = { ...input, approval: heldApproval, adapter: async () => { heldAdapterCalls++; throw new Error("bridge_v2_held_dispatch_forbidden"); } };
    try { await collectDevelopment({ ...heldInput, onCheckpoint(point) { if (point === "intent_durable") throw new Error("bridge_v2_interrupt_after_intent"); } }); }
    catch (error) { if (error.message !== "bridge_v2_interrupt_after_intent") throw error; }
    const held = await collectDevelopment(heldInput);
    let heldExportRefused = false;
    try { await exportMockResultsV2(heldInput); }
    catch (error) { if (error.message !== "collector_export_uncertain_or_unsupported") throw error; heldExportRefused = true; }
    if (heldAdapterCalls || !heldExportRefused || held.stopReason !== "unknown_after_dispatch") throw new Error("bridge_v2_unknown_not_held");
    const incomplete = buildDevelopmentExecutionObservation({ executionDigest: contracts[0].contractDigest, rowId: contracts[0].rowId,
      recordedAt: AT, provenance: "mock-only", journalEntryDigest: hash("synthetic-v2-length-probe"), outcome: returned("{}", "length") });
    const incompleteCompatibility = executionObservationCompatibility({ expected: contracts[0], observed: contracts[0], observation: incomplete });
    if (incompleteCompatibility.disposition !== "hold") throw new Error("bridge_v2_length_not_held");
    const selectionCoverage = (group) => {
      const rowIds = new Set(group.map((row) => row.rowId));
      const dispositions = collected.rows.filter((row) => rowIds.has(row.rowId));
      return { catalogueRows: dispositions.length, planned: dispositions.filter((row) => row.outcome !== "refused").length,
        refused: dispositions.filter((row) => row.outcome === "refused").length, selected: dispositions.filter((row) => row.selected).length,
        observed: dispositions.filter((row) => row.selected && row.outcome !== "not_run").length,
        selectedNotObserved: dispositions.filter((row) => row.selected && row.outcome === "not_run").length,
        unselectedEligible: dispositions.filter((row) => !row.selected && row.outcome === "not_run").length };
    };
    const report = { schemaVersion: "router-development-bridge-report-v2", purpose: "development-only", evidenceStatus: "mock_validation_only",
      providerCalls: 0, incurredProviderSpendUsd: 0, productExecutionVerified: false, productPerformanceDelta: null,
      implementationSource, fixtureSource, simulatedClock: AT, manifestDigest: manifest.collection.manifestDigest, wrapperDigest: manifest.wrapperDigest,
      corpusCoverage: developmentCorpusV2Coverage(corpus, partitions),
      selectionCoverage: { overall: selectionCoverage(plan.rows),
        byModel: plan.models.map(({ modelId }) => ({ modelId, ...selectionCoverage(plan.rows.filter((row) => row.modelId === modelId)) })),
        byCell: ["en", "ko"].flatMap((language) => ["structured-extraction", "grounded-calculation"].flatMap((task) => ["basic", "advanced"].map((difficulty) => ({ language, task, difficulty,
          ...selectionCoverage(plan.rows.filter((row) => row.language === language && row.task === task && row.difficulty === difficulty)) })))),
        byPartition: ["tuning", "development-validation"].map((partition) => ({ partition, ...selectionCoverage(plan.rows.filter((row) => row.partition === partition)) })),
        byFamily: partitions.families.map(({ familyId, partition }) => ({ familyId, partition, ...selectionCoverage(plan.rows.filter((row) => row.familyId === familyId)) })) },
      mockCollection: { selectedRows: 96, adapterCalls: calls.length, recoveredRows, interruptedTerminalRecords: [...interrupted.attempts.values()].filter((attempt) => attempt.terminal).length,
        finalTerminalRecords: [...journal.attempts.values()].filter((attempt) => attempt.terminal).length, repeatedCompletedCalls: calls.length - beforeRepeat,
        stopReason: collected.stopReason, simulatedReservationMicroUsd: journal.totalReservedMicroUsd, actualInvoiceMicroUsd: null,
        populationRows: collected.rows.length, selectedObservedRows: collected.rows.filter((row) => row.selected && row.outcome !== "not_run").length,
        unselectedEligibleRows: collected.rows.filter((row) => !row.selected && row.outcome === "not_run").length, rows: collected.rows },
      uncertainRecovery: { stopReason: held.stopReason, adapterCalls: heldAdapterCalls, dispatchIntents: held.dispatchIntents,
        terminalRecords: held.terminalRecords, exportRefused: heldExportRefused, unknownRows: held.unknownRows },
      incompleteResponse: incompleteCompatibility,
      partialObservationCoverage: { selectedContracts: partial.length, observed: partial.filter((entry) => entry.observation !== null).length,
        notObservedHolds: partial.filter((entry) => entry.compatibility.holdReasons.includes("not_observed")).length },
      compatibility: compatible.map(({ rowId, observation, compatibility }) => ({ rowId, provenance: observation?.provenance ?? null, ...compatibility })),
      metricCoverage: { observedMockRows: observations.length, measuredTokenRows: 0, inputTokens: null, outputTokens: null,
        measuredTtftRows: 0, ttftMs: null, measuredWholeCallRows: 0, wholeCallLatencyMs: null,
        measuredEndToEndRows: 0, endToEndLatencyMs: null, measuredBilledCostRows: 0, providerBilledCostUsd: null },
      capacities: { ...capacities, answers: artifactCapacity(answers), contracts: artifactCapacity(contracts), observations: artifactCapacity(observations) },
      score, replay,
      limitations: ["48 synthetic development cases and a fixed mock stub; no measured model quality or representative traffic claim.",
        "The all-zero source and approval labels are synthetic protocol fixtures, not real execution provenance or human spending authorization.",
        "Original v1/60-call artifacts and source compatibility rules remain separate. No legacy receipt or timing is fabricated.",
        "Shared limits remain unchanged; measured artifact capacities describe this snapshot only, not every 256-model catalogue."] };
    report.capacities.report = { bytes: 0, serializedBytes: 0, nodes: 0, maxBytes: DEVELOPMENT_LIMITS.documentBytes, maxNodes: DEVELOPMENT_LIMITS.nodes };
    for (let attempt = 0; attempt < 10; attempt++) {
      const measured = artifactCapacity(report);
      if (canonicalBenchmarkJson(measured) === canonicalBenchmarkJson(report.capacities.report)) break;
      report.capacities.report = measured;
      if (attempt === 9) throw new Error("bridge_v2_report_capacity_not_stable");
    }
    if (outputDirectory !== null) {
      for (const [name, value] of Object.entries({ "MOCK-ONLY.json": { evidenceStatus: report.evidenceStatus, providerCalls: 0, authorization: "not-human-spending-authorization" },
        "plan.v2.json": plan, "manifest.mock.v2.json": manifest, "contracts.mock.v2.json": contracts, "observations.mock.v2.json": observations,
        "answers.mock.v2.json": answers, "report.v2.json": report })) {
        const serialized = `${JSON.stringify(value, null, 2)}\n`;
        parseBenchmarkJson(serialized);
        writeFileSync(join(directory, name), serialized, { flag: "wx", mode: 0o600 });
      }
    }
    return report;
  } finally {
    if (outputDirectory === null) {
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("router-v2-bridge-")) throw new Error("bridge_v2_cleanup_scope");
      rmSync(target, { recursive: true });
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Offline DEVELOPMENT v2 mock bridge; 48 cases and 96 simulated calls, no providers or credentials.\nnpm run benchmark:router:v2-bridge -- [--output-dir=NEW_DIRECTORY]\nNo flag prints a content-free report and removes its temporary journal. Output directory must be new with an existing parent. There is no live mode or approval input.");
    return;
  }
  if (args.length > 1 || (args.length && !/^--output-dir=.+$/.test(args[0]))) throw new Error("bridge_v2_unknown_argument_no_live_mode");
  const report = await runV2Bridge({ outputDirectory: args[0]?.slice("--output-dir=".length) ?? null });
  console.log(JSON.stringify(args.length ? { evidenceStatus: report.evidenceStatus, providerCalls: 0, populationRows: report.score.summary.catalogueRows,
    selectedRows: report.mockCollection.selectedRows, mockAdapterCalls: report.mockCollection.adapterCalls, recoveredRows: report.mockCollection.recoveredRows,
    scoreSummary: report.score.summary, capacities: report.capacities, report: resolve(args[0].slice("--output-dir=".length), "report.v2.json") } : report, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(JSON.stringify({ error: typeof error.message === "string" && /^[a-z0-9_]{1,120}$/.test(error.message) ? error.message : "bridge_v2_operation_failed" }));
  process.exitCode = 1;
});
