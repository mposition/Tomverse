import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { runExecutionContractSmoke } from "../scripts/router-development-contract-smoke.mjs";
import { parseBenchmarkJson, parseDevelopmentCorpus } from "../lib/routerDevelopmentBenchmark.ts";
import { collectDevelopment, collectorPaths, replayCollectionJournal } from "../lib/routerDevelopmentCollectorJournal.ts";
import { buildCollectionManifest, COLLECTION_VERSION, COLLECTION_ASSUMPTIONS } from "../lib/routerDevelopmentCollector.ts";
import { buildDevelopmentExecutionObservation, collectionExecutionContracts, validateExecutionObservationSet } from "../lib/routerDevelopmentExecution.ts";
import { AVAILABLE_MODELS } from "../lib/models.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "router-execution-cli-test-"));
after(() => {
  const target = resolve(temporary);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith("router-execution-cli-test-"));
  rmSync(target, { recursive: true });
});
const script = resolve(root, "scripts/router-development-contract-smoke.mjs");
const cli = (args) => spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", script, ...args], { cwd: root, encoding: "utf8", maxBuffer: 4_000_000 });
const corpus = parseDevelopmentCorpus(readFileSync(resolve(root, "docs/ops/router-development-benchmark/development-v1.json"), "utf8"));
const frozenContext = (report) => ({ corpus, models: AVAILABLE_MODELS, benchmarkSource: report.fixtureSource, collectorSource: report.fixtureSource });

test("CLI help and rejected live/unknown/duplicate flags never create collector outputs", () => {
  assert.equal(cli(["--help"]).status, 0);
  const before = readdirSync(temporary);
  for (const args of [["--live"], ["--mode=execute"], ["--help", "--live"], ["--output-dir=a", "--output-dir=b"]]) {
    const result = cli(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /mock_unknown_argument_no_live_mode/);
  }
  assert.deepEqual(readdirSync(temporary), before);
});

test("offline mock spans collect, durable restart, journal, export, grader, Replay and uncertain hold", async () => {
  const outputDirectory = join(temporary, "mock-results");
  const originalFetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = () => { networkAttempts++; throw new Error("network_forbidden_in_offline_mock"); };
  let report;
  try { report = await runExecutionContractSmoke({ outputDirectory }); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(networkAttempts, 0);
  assert.equal(report.evidenceStatus, "mock_validation_only");
  assert.equal(report.providerCalls, 0);
  assert.equal(report.incurredProviderSpendUsd, 0);
  assert.deepEqual(report.mockCollection.adapterCalls, 8);
  assert.equal(report.mockCollection.interruptedTerminalRecords, 2);
  assert.equal(report.mockCollection.recoveredRows, 6);
  assert.equal(report.mockCollection.finalTerminalRecords, 8);
  assert.equal(report.mockCollection.repeatedCompletedCalls, 0);
  assert.equal(report.uncertainRecovery.adapterCalls, 0);
  assert.equal(report.uncertainRecovery.dispatchIntents, 1);
  assert.equal(report.uncertainRecovery.terminalRecords, 0);
  assert.equal(report.uncertainRecovery.stopReason, "unknown_after_dispatch");
  assert.equal(report.uncertainRecovery.exportRefused, true);
  assert.equal(report.incompleteResponse.disposition, "hold");
  assert.equal(report.legacyImportWithoutJournal.disposition, "hold");
  assert.deepEqual({ passed: report.score.summary.passed, incorrect: report.score.summary.incorrect, blank: report.score.summary.blank,
    invalidJson: report.score.summary.invalidJson, failed: report.score.summary.failed }, { passed: 4, incorrect: 1, blank: 1, invalidJson: 1, failed: 1 });
  assert.equal(report.score.summary.catalogueRows, 1008);
  assert.equal(report.score.summary.refused, 648);
  assert.equal(report.score.summary.notRun, 352);
  assert.equal(report.score.summary.correctnessRate, null);
  assert.equal(report.score.reportedMetrics.latencyMs.total, null);
  assert.equal(report.score.reportedMetrics.providerCostUsd.total, null);
  assert.equal(report.metricCoverage.measuredTtftRows, 0);
  assert.equal(report.metricCoverage.ttftMs, null);
  assert.equal(report.replay.evidenceStatus, "fixture_validation_only");
  assert.equal(report.replay.benchmarkDomain.paired.populationCases, 24);
  assert.equal(report.replay.benchmarkDomain.paired.commonObservedCases, 4);
  assert.equal(report.replay.benchmarkDomain.paired.wholePopulationCorrectOutcomeShareDelta, null);
  assert.equal(report.productExecutionVerified, false);
  assert.ok(report.compatibility.every((row) => row.productExecutionVerified === false && row.provenance === "mock-only"));
  assert.ok(!Object.hasOwn(report, "answerText"));
  for (const row of report.score.rows) assert.ok(!Object.hasOwn(row, "prompt") && !Object.hasOwn(row, "answerText") && !Object.hasOwn(row, "expected"));

  // Read the persisted bytes back, including the old journal's complete chain validation.
  const readJson = (name) => parseBenchmarkJson(readFileSync(join(outputDirectory, name), "utf8"));
  const manifest = readJson("manifest.mock.json");
  const approval = { schemaVersion: COLLECTION_VERSION, status: "approved", approvalId: "mock-only-main", manifestDigest: manifest.manifestDigest,
    approvedBy: "SYNTHETIC MOCK ONLY; NOT HUMAN SPENDING AUTHORIZATION", approvedAt: report.simulatedClock,
    expiresAt: manifest.limits.expiresAt, acknowledgements: [...COLLECTION_ASSUMPTIONS] };
  const journalText = readFileSync(join(outputDirectory, "router-development-collector-v1.1/mock-only-main.jsonl"), "utf8");
  const journal = replayCollectionJournal(journalText, manifest, approval);
  assert.equal([...journal.attempts.values()].filter((attempt) => attempt.terminal !== null).length, 8);
  assert.equal(validateExecutionObservationSet(readJson("observations.mock.json"), readJson("contracts.mock.json"), { ...frozenContext(report), journalText, manifest, approval }).length, 8);
  const savedAnswers = readJson("answers.mock.json");
  assert.equal(savedAnswers.origin.kind, "synthetic-fixture");
  assert.ok(savedAnswers.origin.description.includes(`Manifest ${manifest.manifestDigest}.`));
  const mutatedJournal = journalText.replace('"mock_provider_error"', '"tampered_provider_error"');
  assert.throws(() => replayCollectionJournal(mutatedJournal, manifest, approval), /journal_chain/);
  const savedReport = readJson("report.json");
  assert.deepEqual(savedReport, report);
});

test("exclusive output directory preserves existing files and the command's provider-facing envelope is gold-free", async () => {
  const sentinel = join(temporary, "keep.txt");
  writeFileSync(sentinel, "do-not-overwrite", { flag: "wx" });
  await assert.rejects(runExecutionContractSmoke({ outputDirectory: temporary }), /EEXIST/);
  assert.equal(readFileSync(sentinel, "utf8"), "do-not-overwrite");
  const source = readFileSync(script, "utf8");
  const importLines = source.split("\n").filter((line) => line.startsWith("import "));
  assert.ok(!importLines.some((line) => /CollectorProvider|activeAiModel|from ["']ai["']|@ai-sdk/.test(line)));
  assert.match(source, /maxOutputTokens,modelId,prompt,settings,signal/);
  assert.ok(!source.includes("process.env[") && !source.includes("resolveProviderApiKey"));
});

test("genuine A and B collection journals reject cross-manifest and relabelled terminal observations", async () => {
  const outputDirectory = join(temporary, "cross-run-results");
  const report = await runExecutionContractSmoke({ outputDirectory });
  const readJson = (name) => parseBenchmarkJson(readFileSync(join(outputDirectory, name), "utf8"));
  const manifestA = readJson("manifest.mock.json");
  const approvalA = { schemaVersion: COLLECTION_VERSION, status: "approved", approvalId: "mock-only-main", manifestDigest: manifestA.manifestDigest,
    approvedBy: "SYNTHETIC MOCK ONLY; NOT HUMAN SPENDING AUTHORIZATION", approvedAt: report.simulatedClock,
    expiresAt: manifestA.limits.expiresAt, acknowledgements: [...COLLECTION_ASSUMPTIONS] };
  const journalTextA = readFileSync(join(outputDirectory, "router-development-collector-v1.1/mock-only-main.jsonl"), "utf8");
  const journalInputA = { ...frozenContext(report), journalText: journalTextA, manifest: manifestA, approval: approvalA };
  const journalA = replayCollectionJournal(journalTextA, manifestA, approvalA);
  assert.equal([...journalA.attempts.values()].filter((attempt) => attempt.terminal !== null).length, 8);
  const contractsA = readJson("contracts.mock.json");
  const observationsA = readJson("observations.mock.json");
  assert.equal(validateExecutionObservationSet(observationsA, contractsA, journalInputA).length, 8);

  const manifestB = buildCollectionManifest({ plan: manifestA.plan, models: AVAILABLE_MODELS, collectorSource: manifestA.collectorSource,
    selectedRowIds: manifestA.selectedRowIds, limits: { ...manifestA.limits, requestTimeoutMs: manifestA.limits.requestTimeoutMs - 1 } });
  assert.notEqual(manifestB.manifestDigest, manifestA.manifestDigest);
  const contractsB = collectionExecutionContracts({ ...frozenContext(report), manifest: manifestB });
  const relabelledObservationsA = observationsA.map((observation) => buildDevelopmentExecutionObservation({
    executionDigest: contractsB.find((contract) => contract.rowId === observation.rowId).contractDigest,
    rowId: observation.rowId, recordedAt: observation.recordedAt, provenance: observation.provenance,
    journalEntryDigest: observation.journalEntryDigest, outcome: observation.outcome,
  }));
  assert.throws(() => validateExecutionObservationSet(relabelledObservationsA, contractsB, journalInputA), /journal_manifest_binding/);
  assert.throws(() => validateExecutionObservationSet(observationsA.slice(0, 1), [contractsA[0], ...contractsB.slice(1)], journalInputA), /journal_manifest_binding/);

  // Produce B's own registration/ledger with the real collector and the same fixed synthetic outcomes.
  const commonDirB = join(temporary, "genuine-b-journal");
  const approvalB = { ...approvalA, approvalId: "mock-genuine-b", manifestDigest: manifestB.manifestDigest };
  let callsB = 0;
  const collectedB = await collectDevelopment({ manifest: manifestB, approval: approvalB, commonDir: commonDirB,
    now: () => Date.parse(report.simulatedClock), assertCurrent() {}, adapter: async (request) => {
      const row = manifestB.plan.rows.find((row) => row.modelId === request.modelId && row.input.prompt === request.prompt);
      const observation = observationsA.find((observation) => observation.rowId === row?.rowId);
      assert.ok(observation);
      callsB++;
      return structuredClone(observation.outcome);
    } });
  assert.equal(callsB, 8);
  assert.equal(collectedB.terminalRecords, 8);
  const journalTextB = readFileSync(collectorPaths(commonDirB, approvalB.approvalId).ledger, "utf8");
  const journalB = replayCollectionJournal(journalTextB, manifestB, approvalB);
  const journalInputB = { ...frozenContext(report), journalText: journalTextB, manifest: manifestB, approval: approvalB };
  const observationsB = journalB.entries.filter((entry) => entry.event.kind === "terminal").map((entry) => buildDevelopmentExecutionObservation({
    executionDigest: contractsB.find((contract) => contract.rowId === entry.event.rowId).contractDigest,
    rowId: entry.event.rowId, recordedAt: entry.event.at, provenance: "mock-only", journalEntryDigest: entry.entryDigest, outcome: entry.event.outcome,
  }));
  assert.equal(validateExecutionObservationSet(observationsB, contractsB, journalInputB).length, 8);
  assert.throws(() => validateExecutionObservationSet(relabelledObservationsA, contractsB, journalInputB), /journal_observation_binding/);
});

test("CLI saves a new mock directory with compact stdout and refuses reuse", () => {
  const destination = join(temporary, "cli-results");
  const first = cli([`--output-dir=${destination}`]);
  assert.equal(first.status, 0, first.stderr);
  const output = JSON.parse(first.stdout);
  assert.equal(output.mockAdapterCalls, 8);
  assert.equal(output.providerCalls, 0);
  assert.equal(output.report, join(destination, "report.json"));
  const preserved = readFileSync(join(destination, "report.json"), "utf8");
  const second = cli([`--output-dir=${destination}`]);
  assert.equal(second.status, 1);
  assert.equal(readFileSync(join(destination, "report.json"), "utf8"), preserved);
});
