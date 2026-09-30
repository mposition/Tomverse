import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkDigest, canonicalBenchmarkJson } from "../lib/routerDevelopmentBenchmark.ts";
import { COLLECTION_ASSUMPTIONS, COLLECTION_VERSION, emptyCollectionObservation } from "../lib/routerDevelopmentCollector.ts";
import {
  buildDevelopmentExecutionContract, buildDevelopmentExecutionObservation, collectionExecutionContracts,
  executionContractMismatches, executionContractRefusals, executionObservationCompatibility,
  legacyExecutionObservationStatus, parseDevelopmentExecutionContract, parseDevelopmentExecutionObservation,
  validateDevelopmentExecutionContract, validateDevelopmentExecutionObservation, validateExecutionObservationSet,
} from "../lib/routerDevelopmentExecution.ts";
import { makeReplayFixture } from "./routerDevelopmentReplayFixture.mjs";

const fixture = makeReplayFixture();
const buildInput = { corpus: fixture.corpus, models: fixture.models, manifest: fixture.manifest,
  benchmarkSource: fixture.observationSource.benchmark, collectorSource: fixture.observationSource.collector };
const contracts = collectionExecutionContracts(buildInput);
const contract = contracts[0];
const hash = (value) => benchmarkDigest(canonicalBenchmarkJson(value));
const changed = (fields = {}) => { const body = { ...contract }; delete body.contractDigest; return buildDevelopmentExecutionContract({ ...body, ...fields }); };
const returned = (text = "{}", finish = "stop") => ({ status: "returned", answerText: text, answerBytes: Buffer.byteLength(text), answerDigest: benchmarkDigest(text),
  textOmitted: false, completeResponse: true, failureCode: null, latencyMs: null,
  observation: { ...emptyCollectionObservation(), source: "provider_body_allowlist", finish } });
const observationFor = (outcome = returned(), overrides = {}) => buildDevelopmentExecutionObservation({ executionDigest: contract.contractDigest,
  rowId: contract.rowId, recordedAt: "2026-09-10T00:00:00.000Z", provenance: "mock-only", journalEntryDigest: "e".repeat(64), outcome, ...overrides });
const compatibility = (observation, observed = contract, expected = contract) => executionObservationCompatibility({ expected, observed, observation });
function journalFixture(outcome = returned(), approvalOverrides = {}, manifest = fixture.manifest) {
  const at = "2026-09-10T00:00:00.000Z";
  const approval = { schemaVersion: COLLECTION_VERSION, status: "approved", approvalId: "mock-unit-journal",
    manifestDigest: manifest.manifestDigest, approvedBy: "SYNTHETIC MOCK ONLY; NOT HUMAN SPENDING AUTHORIZATION",
    approvedAt: at, expiresAt: manifest.limits.expiresAt, acknowledgements: [...COLLECTION_ASSUMPTIONS], ...approvalOverrides };
  const events = [
    { kind: "header", approvalDigest: hash(approval), manifestDigest: manifest.manifestDigest, startedAt: at },
    { kind: "intent", rowId: contract.rowId, at, reservedMicroUsd: manifest.calls[0].reserve.reservedMicroUsd },
    { kind: "terminal", rowId: contract.rowId, at, outcome, tokenUsageAtFrozenRatesMicroUsd: null },
  ];
  let previousDigest = null;
  const entries = events.map((event, seq) => {
    const body = { seq, previousDigest, event };
    const entry = { ...body, entryDigest: hash(body) };
    previousDigest = entry.entryDigest;
    return entry;
  });
  const observation = observationFor(outcome, { journalEntryDigest: entries[2].entryDigest });
  return { observation, input: { ...buildInput, journalText: entries.map((entry) => canonicalBenchmarkJson(entry)).join("\n") + "\n", manifest, approval } };
}

test("canonical field ordering is stable and a collection timestamp does not change the execution contract", () => {
  const reordered = Object.fromEntries(Object.entries(contract).reverse());
  assert.equal(parseDevelopmentExecutionContract(JSON.stringify(reordered)).contractDigest, contract.contractDigest);
  assert.deepEqual(executionContractMismatches(contract, reordered), []);
  const later = observationFor(returned(), { recordedAt: "2026-09-10T00:00:01.000Z" });
  assert.notEqual(later.observationDigest, observationFor().observationDigest);
  assert.equal(later.executionDigest, contract.contractDigest);
  assert.equal(compatibility(later).disposition, "compatible");
});

test("v1 plan/manifest/results are preserved and legacy results cannot invent missing receipts", () => {
  const before = canonicalBenchmarkJson(fixture);
  assert.equal(contracts.length, fixture.manifest.selectedRowIds.length);
  assert.ok(contracts.every((entry) => entry.contextKind === "none"));
  assert.deepEqual(legacyExecutionObservationStatus(fixture.answers, fixture.manifest.plan), {
    disposition: "hold", reason: "v1_result_has_no_execution_context_or_completion_receipt",
    importedRows: fixture.answers.rows.length, productExecutionVerified: false,
  });
  assert.equal(canonicalBenchmarkJson(fixture), before);
  const forged = structuredClone(fixture.answers);
  forged.rows[0].apiModel = "forged";
  assert.throws(() => legacyExecutionObservationStatus(forged, fixture.manifest.plan), /result_apiModel_mismatch/);
});

test("prompt and opaque supplied-context bytes/provenance are distinct bindings", () => {
  assert.deepEqual(executionContractMismatches(contract, changed({ promptDigest: hash("other") })), ["promptDigest"]);
  const context = changed({ contextKind: "supplied-text", contextDigest: hash("opaque-context-bytes"), contextProvenanceDigest: hash("opaque-authorized-origin") });
  assert.deepEqual(executionContractMismatches(contract, context), ["contextKind", "contextDigest", "contextProvenanceDigest"]);
  assert.throws(() => changed({ contextDigest: hash("orphan-context") }), /absent_context_binding/);
  assert.throws(() => changed({ contextKind: "supplied-text" }), /supplied_context_binding/);
  assert.ok(!JSON.stringify(context).includes("opaque-context-bytes"));
});

for (const key of ["modelId", "provider", "apiModel"]) test(`identity mismatch: ${key}`, () => {
  const modified = changed({ [key]: "different-model" });
  assert.deepEqual(executionContractMismatches(contract, modified), [key]);
  assert.equal(compatibility(null, modified).disposition, "incompatible");
});

test("output cap and complete generation settings digest must both match", () => {
  assert.deepEqual(executionContractMismatches(contract, changed({ maxOutputTokens: contract.maxOutputTokens + 1 })), ["maxOutputTokens"]);
  assert.deepEqual(executionContractMismatches(contract, changed({ generationSettingsDigest: hash({ temperature: 0.3 }) })), ["generationSettingsDigest"]);
  assert.throws(() => changed({ maxOutputTokens: 0 }), /output_cap/);
  assert.throws(() => changed({ maxOutputTokens: 2.1 }), /output_cap/);
  assert.throws(() => changed({ maxRetries: 1 }), /version_or_scope/);
});

for (const key of ["search", "tools", "attachments"]) test(`unsupported ${key} stays a refusal even when both contracts match`, () => {
  const unsupported = changed({ [key]: true });
  assert.deepEqual(executionContractRefusals(unsupported), [`${key}_unsupported`]);
  const result = compatibility(null, unsupported, unsupported);
  assert.equal(result.comparedFieldsCompatible, true);
  assert.equal(result.disposition, "incompatible");
  assert.deepEqual(result.refusals, [`${key}_unsupported`]);
  assert.equal(result.productExecutionVerified, false);
});

test("code, corpus, catalogue, policy, plan and manifest drift are explicit mismatches", () => {
  for (const key of ["benchmarkSourceDigest", "collectorSourceDigest", "corpusDigest", "catalogueDigest", "policyDigest", "planDigest", "manifestDigest", "callConfigDigest"]) {
    assert.deepEqual(executionContractMismatches(contract, changed({ [key]: hash(key) })), [key]);
  }
  assert.deepEqual(executionContractMismatches(contract, changed({ sourceCommit: "c".repeat(40) })), ["sourceCommit"]);
  const manifest = structuredClone(fixture.manifest);
  manifest.calls[0].settings = { temperature: 0.5 };
  assert.throws(() => collectionExecutionContracts({ ...buildInput, manifest }), /manifest_snapshot_mismatch/);
  assert.throws(() => collectionExecutionContracts({ ...buildInput, benchmarkSource: { ...buildInput.benchmarkSource, dirty: true } }), /source_not_frozen/);
  assert.throws(() => collectionExecutionContracts({ ...buildInput, benchmarkSource: { ...buildInput.benchmarkSource, files: { changed: hash("source") } } }), /source_snapshot_mismatch/);
});

test("unmeasured runtime fields remain null, and mocks cannot claim provider observations", () => {
  const observation = observationFor();
  assert.equal(observation.ttftMs, null);
  assert.equal(observation.endToEndLatencyMs, null);
  assert.equal(observation.providerBilledCostUsd, null);
  assert.equal(observation.outcome.latencyMs, null);
  for (const key of ["ttftMs", "endToEndLatencyMs", "providerBilledCostUsd"]) {
    assert.throws(() => validateDevelopmentExecutionObservation({ ...observation, [key]: 0 }), /unsupported_metric/);
  }
  assert.throws(() => observationFor({ ...returned(), latencyMs: 1 }), /mock_claims_provider_measurement/);
  assert.throws(() => observationFor({ ...returned(), observation: { ...returned().observation, inputTokens: 0 } }), /mock_claims_provider_measurement/);
});

test("missing, incomplete and unknown completion stay held; complete blanks remain gradeable answers", () => {
  assert.deepEqual(compatibility(null).holdReasons, ["not_observed"]);
  assert.deepEqual(compatibility(observationFor(returned("{}", "length"))).holdReasons, ["incomplete_response"]);
  assert.deepEqual(compatibility(observationFor(returned("{}", "unknown"))).holdReasons, ["completion_not_confirmed"]);
  for (const text of ["", "  ", "not-json", "{}"]) {
    const result = compatibility(observationFor(returned(text)));
    assert.equal(result.disposition, "compatible");
    assert.equal(result.outcomeClass, "gradeable_returned_answer");
    assert.equal(result.productPerformanceDelta, null);
    assert.equal(result.productExecutionVerified, false);
  }
});

test("known acquisition failures/timeouts are distinct from correctness and uncertain acquisition", () => {
  for (const status of ["failed", "timeout", "unknown", "measurement_unsupported"]) {
    const outcome = { status, answerText: null, answerBytes: null, answerDigest: null, textOmitted: false,
      completeResponse: status === "failed", failureCode: "mock_failure", latencyMs: null, observation: emptyCollectionObservation() };
    const result = compatibility(observationFor(outcome));
    if (status === "failed" || status === "timeout") {
      assert.equal(result.disposition, "compatible");
      assert.equal(result.outcomeClass, status === "timeout" ? "acquisition_timeout" : "acquisition_failure");
    } else assert.equal(result.disposition, "hold");
  }
});

test("known output/reasoning bound violations remain held without fabricating missing usage", () => {
  const outcome = returned();
  outcome.observation.reasoningTokens = contract.maxOutputTokens + 1;
  const observation = observationFor(outcome, { provenance: "local-collector-unverified" });
  assert.equal(observation.outcome.observation.outputTokens, null);
  assert.deepEqual(compatibility(observation).holdReasons, ["observed_output_bound_exceeded"]);
});

test("observations bind exact contracts, reject duplicates, and match read-back journal contents", () => {
  const { observation, input } = journalFixture();
  assert.equal(validateExecutionObservationSet([observation], [contract], input).length, 1);
  assert.throws(() => validateExecutionObservationSet([observation, observation], contracts, input), /duplicate_observation/);
  assert.throws(() => validateExecutionObservationSet([observation], [contract, contract], input), /duplicate_contract/);
  assert.throws(() => compatibility(observationFor(returned(), { executionDigest: hash("wrong") })), /observation_contract_binding/);
  for (const overrides of [{ outcome: returned("changed") }, { recordedAt: "2026-09-10T00:00:01.000Z" }, { journalEntryDigest: hash("other-receipt") }]) {
    assert.throws(() => validateExecutionObservationSet([observationFor(overrides.outcome ?? returned(), { ...overrides, journalEntryDigest: overrides.journalEntryDigest ?? observation.journalEntryDigest })], [contract], input), /journal_observation_binding/);
  }
});

test("raw journal chain, manifest body and approval checks run inside the observation boundary", () => {
  const { observation, input } = journalFixture();
  const fabricated = { entries: [{ event: { kind: "header", manifestDigest: contract.manifestDigest } }, { entryDigest: observation.journalEntryDigest,
    event: { kind: "terminal", rowId: observation.rowId, at: observation.recordedAt, outcome: observation.outcome } }] };
  assert.throws(() => validateExecutionObservationSet([observation], [contract], fabricated), /execution_journal_input/);
  assert.throws(() => validateExecutionObservationSet([observation], [contract], { ...input, journalText: fabricated }), /journal_text_type_or_byte_limit/);
  const tampered = input.journalText.replace('"seq":1', '"seq":9');
  assert.throws(() => validateExecutionObservationSet([observation], [contract], { ...input, journalText: tampered }), /journal_chain/);
  assert.throws(() => validateExecutionObservationSet([observation], [contract], { ...input,
    manifest: { ...input.manifest, limits: { ...input.manifest.limits, requestTimeoutMs: 59999 } } }), /journal_manifest_digest/);
  for (const overrides of [{ status: "proposal" }, { approvedAt: "2026-09-10T00:00:01.000Z" }]) {
    const invalid = journalFixture(returned(), overrides);
    assert.throws(() => validateExecutionObservationSet([invalid.observation], [contract], invalid.input), /collector_approval_/);
  }
});

test("contracts without observations retain their row identities and not_observed holds", () => {
  const { observation, input } = journalFixture();
  const partial = validateExecutionObservationSet([observation], contracts, input);
  assert.equal(partial.length, contracts.length);
  assert.deepEqual(partial.map((row) => row.rowId), contracts.map((row) => row.rowId));
  assert.equal(partial[0].compatibility.disposition, "compatible");
  for (const row of partial.slice(1)) {
    assert.equal(row.observation, null);
    assert.equal(row.compatibility.disposition, "hold");
    assert.deepEqual(row.compatibility.holdReasons, ["not_observed"]);
  }
  const empty = validateExecutionObservationSet([], contracts, input);
  assert.equal(empty.length, contracts.length);
  assert.ok(empty.every((row) => row.observation === null && row.compatibility.holdReasons[0] === "not_observed"));
});

test("rehashing an invalid plan cannot manufacture an authoritative collection contract", () => {
  const bad = structuredClone(fixture.manifest);
  bad.plan.rows[0].modelId = "not-a-model";
  const { planDigest: unusedPlanDigest, ...planBody } = bad.plan;
  bad.plan.planDigest = hash(planBody);
  const { manifestDigest: unusedManifestDigest, ...manifestBody } = bad;
  bad.manifestDigest = hash(manifestBody);
  assert.notEqual(bad.plan.planDigest, unusedPlanDigest);
  assert.notEqual(bad.manifestDigest, unusedManifestDigest);
  const { observation, input } = journalFixture(returned(), {}, bad);
  const forgedContract = changed({ planDigest: bad.plan.planDigest, manifestDigest: bad.manifestDigest });
  const forgedObservation = observationFor(observation.outcome, { journalEntryDigest: observation.journalEntryDigest,
    executionDigest: forgedContract.contractDigest });
  assert.throws(() => collectionExecutionContracts({ ...buildInput, manifest: bad }), /plan/);
  assert.throws(() => validateExecutionObservationSet([forgedObservation], [forgedContract], input), /plan/);
});

test("self-consistent supplied contracts must match the independently reconstructed row", () => {
  const { observation, input } = journalFixture();
  for (const fields of [{ maxOutputTokens: contract.maxOutputTokens + 1 }, { modelId: "not-a-model" },
    { generationSettingsDigest: hash({ temperature: 0.5 }) }, { rowId: "not-a-selected-row" }]) {
    const forgedContract = changed(fields);
    const forgedObservation = observationFor(observation.outcome, { rowId: forgedContract.rowId,
      journalEntryDigest: observation.journalEntryDigest, executionDigest: forgedContract.contractDigest });
    assert.throws(() => validateExecutionObservationSet([forgedObservation], [forgedContract], input), /journal_contract_snapshot_mismatch/);
  }
});

test("strict bounded parsers reject tampering, extra gold fields, duplicate keys and oversize documents", () => {
  assert.throws(() => validateDevelopmentExecutionContract({ ...contract, apiModel: "forged" }), /contract_digest_mismatch/);
  assert.throws(() => validateDevelopmentExecutionContract({ ...contract, expected: {} }), /execution_contract/);
  assert.throws(() => parseDevelopmentExecutionContract('{"purpose":"development-only","purpose":"development-only"}'), /json_duplicate_key/);
  assert.throws(() => parseDevelopmentExecutionContract(" ".repeat(16_385)), /byte_limit/);
  assert.throws(() => parseDevelopmentExecutionObservation(" ".repeat(2_097_153)), /byte_limit/);
  assert.throws(() => parseDevelopmentExecutionObservation(JSON.stringify({ ...observationFor(), answer: "extra" })), /execution_observation/);
  const nested = `${"[".repeat(34)}null${"]".repeat(34)}`;
  assert.throws(() => parseDevelopmentExecutionObservation(nested), /json_complexity_limit/);
});
