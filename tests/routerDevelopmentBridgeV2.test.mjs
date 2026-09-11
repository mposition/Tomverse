import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import net from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { before, after } from "node:test";
import "./routerDevelopmentOfflineGuard.mjs";
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "../lib/models.ts";
import { benchmarkDigest, canonicalBenchmarkJson, parseBenchmarkJson, DEVELOPMENT_LIMITS } from "../lib/routerDevelopmentBenchmark.ts";
import { parseDevelopmentCorpusV2, parseDevelopmentPartitionsV2 } from "../lib/routerDevelopmentCorpusV2.ts";
import { buildMockManifestV2, validateMockManifestV2, mockApprovalV2, collectionExecutionContractsV2,
  validateExecutionObservationSetV2, exportMockResultsV2, replayMockDevelopmentV2, selectReplayModelsV2 } from "../lib/routerDevelopmentBridgeV2.ts";
import { buildDevelopmentExecutionObservation } from "../lib/routerDevelopmentExecution.ts";
import { collectDevelopment, collectorPaths, replayCollectionJournal } from "../lib/routerDevelopmentCollectorJournal.ts";
import { runV2Bridge, V2_BRIDGE_SOURCE_PATHS } from "../scripts/router-development-v2-bridge.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "router-v2-bridge-test-"));
const output = join(temporary, "main");
const corpus = parseDevelopmentCorpusV2(readFileSync(resolve(root, "docs/ops/router-development-benchmark/development-v2.json"), "utf8"));
const partitions = parseDevelopmentPartitionsV2(readFileSync(resolve(root, "docs/ops/router-development-benchmark/development-v2-partitions.json"), "utf8"), corpus);
const hash = (value) => benchmarkDigest(canonicalBenchmarkJson(value));
const guard = pathToFileURL(resolve(root, "tests/routerDevelopmentOfflineGuard.mjs")).href;
const cli = (args, script = "scripts/router-development-v2-bridge.mjs") => spawnSync(process.execPath,
  ["--import", guard, "--conditions=react-server", "--import", "tsx", resolve(root, script), ...args], { cwd: root, encoding: "utf8", maxBuffer: 8_000_000 });
const readJson = (name) => parseBenchmarkJson(readFileSync(join(output, name), "utf8"));
let report, manifest, plan, answers, contracts, observations, journalText, context, approval;
before(async () => {
  report = await runV2Bridge({ outputDirectory: output });
  manifest = readJson("manifest.mock.v2.json"); plan = readJson("plan.v2.json"); answers = readJson("answers.mock.v2.json");
  contracts = readJson("contracts.mock.v2.json"); observations = readJson("observations.mock.v2.json");
  context = { corpus, partitions, models: AVAILABLE_MODELS, benchmarkSource: report.fixtureSource, collectorSource: report.fixtureSource };
  approval = mockApprovalV2(manifest);
  journalText = readFileSync(collectorPaths(output, approval.approvalId).ledger, "utf8");
});
after(() => {
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
  assert.ok(basename(temporary).startsWith("router-v2-bridge-test-"));
  rmSync(temporary, { recursive: true });
});
const replayInput = () => ({ ...context, manifest, answers, candidate: policy(),
  replaySource: report.implementationSource, contracts, observations, journalText, approval });
const policy = () => ({ schemaVersion: "router-development-replay-policy-v1", purpose: "development-only", policyId: "v2-test-control", preferences: { general: [DEFAULT_MODEL_ID] }, fallback: "original-router" });

test("48-case bridge retains all catalogue rows, 96 calls and 2/94/0 durable resume", () => {
  assert.equal(report.providerCalls, 0);
  assert.equal(report.incurredProviderSpendUsd, 0);
  assert.equal(report.mockCollection.selectedRows, 96);
  assert.equal(report.mockCollection.adapterCalls, 96);
  assert.equal(report.mockCollection.interruptedTerminalRecords, 2);
  assert.equal(report.mockCollection.recoveredRows, 94);
  assert.equal(report.mockCollection.repeatedCompletedCalls, 0);
  assert.equal(report.mockCollection.finalTerminalRecords, 96);
  assert.equal(report.score.summary.catalogueRows, 48 * AVAILABLE_MODELS.length);
  assert.equal(report.score.summary.catalogueRows, 2016);
  assert.equal(report.score.summary.submitted, 96);
  assert.deepEqual({ passed: report.score.summary.passed, incorrect: report.score.summary.incorrect,
    blank: report.score.summary.blank, invalidJson: report.score.summary.invalidJson, failed: report.score.summary.failed },
  { passed: 92, incorrect: 1, blank: 1, invalidJson: 1, failed: 1 });
  assert.equal(report.score.summary.correctnessRate, null);
  assert.equal(report.selectionCoverage.overall.planned + report.selectionCoverage.overall.refused, 2016);
  assert.equal(report.selectionCoverage.overall.planned, 720);
  assert.equal(report.selectionCoverage.overall.refused, 1296);
  assert.equal(report.selectionCoverage.overall.selected + report.selectionCoverage.overall.unselectedEligible, report.selectionCoverage.overall.planned);
});

test("eight cells, twelve families and whole-family 24/24 partitions retain selection denominators", () => {
  assert.equal(report.selectionCoverage.byCell.length, 8);
  assert.ok(report.selectionCoverage.byCell.every((cell) => cell.catalogueRows === 6 * AVAILABLE_MODELS.length && cell.selected === 12 && cell.observed === 12));
  assert.deepEqual(report.selectionCoverage.byPartition.map((part) => part.catalogueRows), [24 * AVAILABLE_MODELS.length, 24 * AVAILABLE_MODELS.length]);
  assert.deepEqual(report.selectionCoverage.byPartition.map((part) => part.selected), [48, 48]);
  assert.equal(report.selectionCoverage.byFamily.length, 12);
  assert.ok(report.selectionCoverage.byFamily.every((family) => family.selected === 8));
  assert.equal(report.selectionCoverage.byModel.length, AVAILABLE_MODELS.length);
  assert.equal(report.selectionCoverage.byModel.reduce((sum, model) => sum + model.catalogueRows, 0), 2016);
  assert.equal(report.selectionCoverage.byModel.reduce((sum, model) => sum + model.selected, 0), 96);
  assert.equal(report.selectionCoverage.byModel.filter((model) => model.selected === 48).length, 2);
  assert.ok(report.selectionCoverage.byModel.every((model) => model.selectedNotObserved === 0));
  assert.equal(report.replay.benchmarkDomain.paired.populationCases, 48);
  assert.ok(report.replay.byCell.every((cell) => cell.paired.populationCases === 6));
  assert.deepEqual(report.replay.byPartition.map((part) => part.paired.populationCases), [24, 24]);
});

test("all mock metrics remain null and unknown intent cannot resume or export", () => {
  assert.equal(report.uncertainRecovery.adapterCalls, 0);
  assert.equal(report.uncertainRecovery.dispatchIntents, 1);
  assert.equal(report.uncertainRecovery.terminalRecords, 0);
  assert.equal(report.uncertainRecovery.stopReason, "unknown_after_dispatch");
  assert.equal(report.uncertainRecovery.exportRefused, true);
  assert.equal(report.incompleteResponse.disposition, "hold");
  assert.deepEqual(report.partialObservationCoverage, { selectedContracts: 96, observed: 2, notObservedHolds: 94 });
  assert.ok(answers.rows.every((row) => row.recordedAt === null && Object.values(row.metrics).every((metric) => metric === null)));
  assert.ok(observations.every((row) => row.provenance === "mock-only" && row.ttftMs === null && row.endToEndLatencyMs === null && row.providerBilledCostUsd === null));
  assert.equal(report.productPerformanceDelta, null);
  assert.equal(report.replay.productExecutionVerified, false);
  assert.equal(report.replay.benchmarkDomain.baseline.latencyMs, null);
});

test("persisted artifacts reparse under unchanged byte/node limits and source list covers the bridge", () => {
  assert.equal(DEVELOPMENT_LIMITS.nodes, 200_000);
  assert.equal(DEVELOPMENT_LIMITS.documentBytes, 16_777_216);
  for (const capacity of Object.values(report.capacities)) {
    assert.ok(capacity.bytes < capacity.maxBytes);
    assert.ok(capacity.serializedBytes < capacity.maxBytes);
    assert.ok(capacity.nodes < capacity.maxNodes);
  }
  for (const name of readdirSync(output).filter((name) => name.endsWith(".json"))) assert.doesNotThrow(() => readJson(name));
  for (const path of ["lib/routerDevelopmentBenchmarkPlan.ts", "lib/routerDevelopmentCorpusV2.ts", "lib/routerDevelopmentPlanV2.ts", "lib/routerDevelopmentResultsV2.ts", "lib/routerDevelopmentBridgeV2.ts", "package.json", "package-lock.json", "tsconfig.json"]) assert.ok(V2_BRIDGE_SOURCE_PATHS.includes(path));
  assert.equal(report.fixtureSource.commit, "0".repeat(40));
  assert.notEqual(report.implementationSource.commit, report.fixtureSource.commit);
  assert.equal(report.capacities.report.bytes, Buffer.byteLength(canonicalBenchmarkJson(report)));
  assert.equal(report.capacities.report.serializedBytes, Buffer.byteLength(readFileSync(join(output, "report.v2.json"))));
});

test("manifest and receipts refuse rehashed plan, partition, model, cap and observation substitutions", () => {
  assert.equal(validateMockManifestV2(manifest, context).wrapperDigest, manifest.wrapperDigest);
  for (const mutate of [
    (value) => { value.collection.plan.rows[0].apiModel = "forged"; },
    (value) => { value.collection.plan.partitionDigest = "a".repeat(64); },
    (value) => { value.collection.calls[0].reserve.outputCapTokens = 1; },
    (value) => { value.collection.calls[0].settings = { temperature: 0.123 }; },
  ]) {
    const value = structuredClone(manifest); mutate(value);
    const body = { ...value.collection }; delete body.manifestDigest; value.collection.manifestDigest = hash(body);
    const wrapper = { ...value }; delete wrapper.wrapperDigest; value.wrapperDigest = hash(wrapper);
    assert.throws(() => validateMockManifestV2(value, context));
  }
  assert.throws(() => validateExecutionObservationSetV2([observations[0], observations[0]], contracts, { ...context, manifest, approval, journalText }), /duplicate_observation/);
  assert.throws(() => validateExecutionObservationSetV2(observations, contracts, { ...context, manifest, approval, journalText: journalText.replace('"seq":1', '"seq":9') }), /journal_chain/);
  const swapped = buildDevelopmentExecutionObservation({ ...Object.fromEntries(Object.entries(observations[0]).filter(([key]) => !["schemaVersion", "purpose", "ttftMs", "endToEndLatencyMs", "providerBilledCostUsd", "observationDigest"].includes(key))), journalEntryDigest: observations[1].journalEntryDigest });
  assert.throws(() => validateExecutionObservationSetV2([swapped], contracts, { ...context, manifest, approval, journalText }), /journal_observation_binding/);
});

test("Replay requires exact journal receipts and keeps missing observations unavailable", () => {
  const input = replayInput();
  assert.equal(replayMockDevelopmentV2(input).benchmarkDomain.paired.populationCases, 48);
  const changed = structuredClone(answers); changed.rows[0].answerText = "{}"; changed.rows[0].answerDigest = benchmarkDigest("{}");
  assert.throws(() => replayMockDevelopmentV2({ ...input, answers: changed }), /replay_answer_receipt_mismatch/);
  assert.throws(() => replayMockDevelopmentV2({ ...input, observations: observations.slice(1) }), /replay_execution_held/);
  const partialAnswers = { ...answers, rows: answers.rows.slice(2) };
  const partial = replayMockDevelopmentV2({ ...input, answers: partialAnswers, observations: observations.slice(2) });
  assert.equal(partial.benchmarkDomain.paired.wholePopulationCorrectOutcomeShareDelta, null);
  assert.ok(partial.benchmarkDomain.paired.unavailablePairCases > 0);
});

test("genuine separate mock journals refuse a terminal rebound under another manifest", async () => {
  const other = buildMockManifestV2({ ...context, plan, selectedRowIds: [manifest.collection.selectedRowIds[0]], limits: manifest.collection.limits });
  const otherApproval = mockApprovalV2(other, "other");
  const directory = join(temporary, "other-run");
  await collectDevelopment({ manifest: other.collection, approval: otherApproval, commonDir: directory,
    now: () => Date.parse(report.simulatedClock), assertCurrent() {}, adapter: async () => structuredClone(observations[0].outcome) });
  const otherText = readFileSync(collectorPaths(directory, otherApproval.approvalId).ledger, "utf8");
  const otherContracts = collectionExecutionContractsV2({ ...context, manifest: other });
  const state = replayCollectionJournal(otherText, other.collection, otherApproval);
  const terminal = state.entries.find((entry) => entry.event.kind === "terminal");
  const genuine = buildDevelopmentExecutionObservation({ executionDigest: otherContracts[0].contractDigest, rowId: otherContracts[0].rowId,
    recordedAt: terminal.event.at, provenance: "mock-only", journalEntryDigest: terminal.entryDigest, outcome: terminal.event.outcome });
  const bound = { ...context, manifest: other, approval: otherApproval, journalText: otherText };
  assert.equal(validateExecutionObservationSetV2([genuine], otherContracts, bound)[0].compatibility.disposition, "compatible");
  const rebound = buildDevelopmentExecutionObservation({ executionDigest: otherContracts[0].contractDigest, rowId: otherContracts[0].rowId,
    recordedAt: observations[0].recordedAt, provenance: "mock-only", journalEntryDigest: observations[0].journalEntryDigest, outcome: observations[0].outcome });
  assert.throws(() => validateExecutionObservationSetV2([rebound], otherContracts, bound), /journal_observation_binding/);
  assert.throws(() => validateExecutionObservationSetV2([genuine], otherContracts, { ...bound, journalText }), /journal_identity/);
});

test("length and unknown finish cannot export or Replay a gradeable v2 result", async () => {
  for (const finish of ["length", "unknown"]) {
    const directory = join(temporary, finish);
    const one = buildMockManifestV2({ ...context, plan, selectedRowIds: [manifest.collection.selectedRowIds[0]], limits: manifest.collection.limits });
    const oneApproval = mockApprovalV2(one, "other");
    const outcome = structuredClone(observations[0].outcome); outcome.observation.finish = finish;
    const run = { ...context, manifest: one.collection, mockManifest: one, approval: oneApproval, commonDir: directory,
      now: () => Date.parse(report.simulatedClock), assertCurrent() {}, adapter: async () => outcome };
    await collectDevelopment(run);
    await assert.rejects(exportMockResultsV2(run), /export_execution_held/);
    const text = readFileSync(collectorPaths(directory, oneApproval.approvalId).ledger, "utf8");
    const state = replayCollectionJournal(text, one.collection, oneApproval);
    const oneContracts = collectionExecutionContractsV2({ ...context, manifest: one });
    const terminal = state.entries.find((entry) => entry.event.kind === "terminal");
    const receipt = buildDevelopmentExecutionObservation({ executionDigest: oneContracts[0].contractDigest, rowId: oneContracts[0].rowId,
      recordedAt: terminal.event.at, provenance: "mock-only", journalEntryDigest: terminal.entryDigest, outcome: terminal.event.outcome });
    const fake = { ...answers, planDigest: one.collection.plan.planDigest, rows: [answers.rows[0]] };
    await assert.rejects(async () => replayMockDevelopmentV2({ ...context, manifest: one, answers: fake, candidate: policy(), replaySource: report.implementationSource,
      contracts: oneContracts, observations: [receipt], journalText: text, approval: oneApproval }), /replay_execution_held/);
  }
});

test("distinct mock manifest and v2 plan are refused by legacy live CLI before provider import", async () => {
  const localPipe = join(tmpdir(), `tsx-${typeof process.geteuid === "function" ? process.geteuid() : userInfo().username}`, `${process.ppid}.pipe`);
  const parentPipe = process.platform === "win32" ? `\\\\?\\pipe\\${localPipe}` : localPipe;
  let connected = false;
  const simulated = net.createConnection(parentPipe, () => { connected = true; });
  assert.equal(simulated instanceof net.Socket, false);
  await new Promise((done) => simulated.on("error", done));
  assert.equal(connected, false);
  const originalWrite = process.stderr.write;
  const blocked = [];
  try {
    process.stderr.write = (text) => { blocked.push(text); return true; };
    assert.throws(() => net.createConnection(`${parentPipe}-near-miss`), /offline_network_forbidden/);
    assert.throws(() => net.createConnection({ host: "network.invalid", port: 443 }), /offline_network_forbidden/);
  } finally { process.stderr.write = originalWrite; }
  assert.equal(blocked.length, 2);
  const approvalPath = join(temporary, "approval.mock.json"); writeFileSync(approvalPath, JSON.stringify(approval));
  const wrapper = cli(["--mode=execute", "--live", `--manifest=${join(output, "manifest.mock.v2.json")}`, `--approval=${approvalPath}`], "scripts/router-development-collect.mjs");
  assert.equal(wrapper.status, 1); assert.match(wrapper.stderr, /collector_input_output_or_snapshot_error/); assert.doesNotMatch(wrapper.stderr, /OFFLINE_NETWORK_ATTEMPT/);
  const innerPath = join(temporary, "inner.mock.json"); writeFileSync(innerPath, JSON.stringify(manifest.collection));
  const inner = cli(["--mode=execute", "--live", `--manifest=${innerPath}`, `--approval=${approvalPath}`], "scripts/router-development-collect.mjs");
  assert.equal(inner.status, 1); assert.match(inner.stderr, /collector_input_output_or_snapshot_error|plan_version_or_purpose/); assert.doesNotMatch(inner.stderr, /OFFLINE_NETWORK_ATTEMPT/);
});

test("strict no-live CLI and exclusive artifact directory preserve existing outputs", async () => {
  assert.equal(cli(["--help"]).status, 0);
  const beforeNames = readdirSync(temporary);
  for (const args of [["--live"], ["--mode=execute"], ["--approval=anything"], ["--help", "--live"], ["--output-dir=a", "--output-dir=b"]]) {
    const result = cli(args); assert.equal(result.status, 1); assert.match(result.stderr, /bridge_v2_unknown_argument_no_live_mode/);
  }
  assert.deepEqual(readdirSync(temporary), beforeNames);
  const before = readFileSync(join(output, "report.v2.json"));
  await assert.rejects(runV2Bridge({ outputDirectory: output }));
  assert.deepEqual(readFileSync(join(output, "report.v2.json")), before);
});

test("plan and report are content-free outside explicit prompt artifact and selector reads no gold", () => {
  const prohibited = new Set(["expected", "gold", "grading", "answerText", "prompt"]);
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) { assert.ok(!prohibited.has(key), key); walk(child); }
  };
  walk(report);
  const planText = JSON.stringify(plan);
  for (const field of ["expected", "grading", "gold"]) assert.ok(!planText.includes(`"${field}":`));
  const guarded = structuredClone(plan);
  for (const name of ["expected", "gold", "answers", "grades"]) Object.defineProperty(guarded, name, { get() { assert.fail("gold_entered_selection"); } });
  assert.equal(selectReplayModelsV2(guarded, AVAILABLE_MODELS, policy()).length, 48);
});
