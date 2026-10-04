import assert from "node:assert/strict";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
import test, { after } from "node:test";

// Synthetic adversarial fixtures only. No object below authorizes a paid run.
// Keep the existing offline CLI test's transport trap active before app imports.
// Reference: tests/routerDevelopmentBenchmarkCli.test.mjs:18.
const restored = [];
for (const [target, key] of [
  [globalThis, "fetch"], [http, "request"], [http, "get"],
  [https, "request"], [https, "get"], [net, "connect"],
  [net, "createConnection"], [net.Socket.prototype, "connect"],
  [tls, "connect"], [dgram, "createSocket"],
]) {
  restored.push([target, key, target[key]]);
  target[key] = () => { throw new Error("ADVERSARIAL_TEST_NETWORK_FORBIDDEN"); };
}
syncBuiltinESMExports();
after(() => {
  for (const [target, key, original] of restored) target[key] = original;
  syncBuiltinESMExports();
});

const {
  COLLECTION_ASSUMPTIONS, COLLECTION_LIMITS, COLLECTION_VERSION,
  buildCollectionManifest, ceilTokenMicroUsd, collectionHash,
  emptyCollectionObservation, estimateCollectionUsageCost, reserveCollectionCost,
  sumCollectionMoney, validateCollectionApproval, validateCollectionLimits,
  validateCollectionManifest, validateCollectionOutcome,
} = await import("../lib/routerDevelopmentCollector.ts");
const {
  benchmarkDigest, canonicalBenchmarkJson, DEVELOPMENT_LIMITS, parseDevelopmentCorpus,
  scoreDevelopmentResults,
} = await import("../lib/routerDevelopmentBenchmark.ts");
const { buildDevelopmentPlan } = await import("../lib/routerDevelopmentBenchmarkPlan.ts");
const { AVAILABLE_MODELS, DEFAULT_MODEL_ID } = await import("../lib/models.ts");
const {
  collectDevelopment, collectorPaths, exportDevelopmentCollection,
  replayCollectionJournal, writeCollectionDurably,
} = await import("../lib/routerDevelopmentCollectorJournal.ts");
const {
  collectionReturnedOutcome, createCollectionSdkAdapter, observeCollectionBody,
} = await import("../lib/routerDevelopmentCollectorProvider.ts");

const corpus = parseDevelopmentCorpus(readFileSync(new URL("../docs/ops/router-development-benchmark/development-v1.json", import.meta.url), "utf8"));
const source = { commit: "a".repeat(40), dirty: false, files: { "synthetic-test-only": "b".repeat(64) } };
const instant = "2026-09-10T00:00:00.000Z";
const plan = buildDevelopmentPlan({ corpus, models: AVAILABLE_MODELS, source, requestedModelId: DEFAULT_MODEL_ID, plan: "Pro", createdAt: instant });
const eligible = plan.rows.filter((row) => row.benchmarkEligibility.eligible);
const limits = {
  maxTotalMicroUsd: 1_000_000_000, maxRequestMicroUsd: 1_000_000_000,
  maxCalls: 1008, requestTimeoutMs: 1000, runTimeoutMs: 60_000,
  expiresAt: "2026-09-10T00:01:00.000Z",
};
const manifestInput = { plan, models: AVAILABLE_MODELS, collectorSource: source };
const manifest = buildCollectionManifest({ ...manifestInput, selectedRowIds: eligible.slice(0, 2).map((row) => row.rowId), limits });
const syntheticApproval = (target = manifest) => ({
  schemaVersion: COLLECTION_VERSION, status: "approved", approvalId: "synthetic-test-no-paid-authority",
  manifestDigest: target.manifestDigest, approvedBy: "SYNTHETIC TEST FIXTURE; NOT AN OPERATOR APPROVAL",
  approvedAt: instant, expiresAt: target.limits.expiresAt, acknowledgements: [...COLLECTION_ASSUMPTIONS],
});
const tier = (overrides = {}) => ({ maxPromptTokens: null, inputUsdPerMillionTokens: 0.1, outputUsdPerMillionTokens: 0.1, cachedInputPriceMultiplier: 1, cacheWriteUsdPerMillionTokens: 0.1, ...overrides });
const observed = (overrides = {}) => ({ ...emptyCollectionObservation(), source: "provider_body_allowlist", inputTokens: 3, noCacheInputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, outputTokens: 1, ...overrides });
const pricedCall = (tiers = [tier()]) => ({ pricing: { tiers } });
const returned = (answerText = "{}", overrides = {}) => ({
  status: "returned", answerText, answerBytes: Buffer.byteLength(answerText), answerDigest: benchmarkDigest(answerText),
  textOmitted: false, completeResponse: true, failureCode: null, latencyMs: null,
  observation: emptyCollectionObservation(), ...overrides,
});

test("adversarial harness blocks accidental fetch and socket traffic", () => {
  assert.throws(() => fetch("https://example.invalid"), /ADVERSARIAL_TEST_NETWORK_FORBIDDEN/);
  assert.throws(() => net.connect(443, "example.invalid"), /ADVERSARIAL_TEST_NETWORK_FORBIDDEN/);
});

test("microUSD arithmetic rounds decimal and exponent rates upward without float truncation", () => {
  for (const [tokens, rate, expected] of [
    [3, 0.1, 1], [10, 0.1, 1], [11, 0.1, 2], [1, 1.2, 2],
    [1_000_001, 1e-6, 2], [9, 1e-7, 1], [0, 100, 0],
    [1, 1.7999999999999998, 2],
  ]) assert.equal(ceilTokenMicroUsd(tokens, rate), expected, `${tokens} tokens at ${rate}`);
});

test("reservation covers independently rounded no-cache/read/write/output categories", () => {
  // Four independently billed categories each round ceil(1 * 0.1) to one microUSD.
  // Rounding the combined input only once yields two microUSD and is insufficient.
  const measured = estimateCollectionUsageCost(observed(), pricedCall());
  assert.equal(measured, 4);
  assert.ok(reserveCollectionCost(3, 1, [tier()]).reservedMicroUsd >= measured,
    "reservation must cover 4 microUSD, not just ceil(3 * 0.1) + ceil(1 * 0.1)");
});

test("reservation dominates every small disjoint input-category partition across all tiers", () => {
  const tiers = [tier({ maxPromptTokens: 5 }), tier({ inputUsdPerMillionTokens: 0.25, cachedInputPriceMultiplier: 0.5, cacheWriteUsdPerMillionTokens: 0.75, outputUsdPerMillionTokens: 0.5 })];
  for (let context = 1; context <= 8; context += 1) {
    for (let output = 1; output <= 3; output += 1) {
      const reserved = reserveCollectionCost(context, output, tiers).reservedMicroUsd;
      for (const price of tiers) {
        for (let uncached = 0; uncached <= context; uncached += 1) {
          for (let cached = 0; cached <= context - uncached; cached += 1) {
            const writes = context - uncached - cached;
            const independent = Math.ceil(uncached * price.inputUsdPerMillionTokens)
              + Math.ceil(cached * price.inputUsdPerMillionTokens * price.cachedInputPriceMultiplier)
              + Math.ceil(writes * price.cacheWriteUsdPerMillionTokens)
              + Math.ceil(output * price.outputUsdPerMillionTokens);
            assert.ok(reserved >= independent, JSON.stringify({ context, output, uncached, cached, writes, reserved, independent }));
          }
        }
      }
    }
  }
});

test("reservation uses the highest input, cache-write and output rates across tiers", () => {
  const reserved = reserveCollectionCost(10, 2, [
    tier({ maxPromptTokens: 5, inputUsdPerMillionTokens: 3, cachedInputPriceMultiplier: 2, outputUsdPerMillionTokens: 9 }),
    tier({ inputUsdPerMillionTokens: 1, cacheWriteUsdPerMillionTokens: 8, outputUsdPerMillionTokens: 4 }),
  ]);
  assert.equal(reserved.maxInputRate, 8);
  assert.equal(reserved.maxOutputRate, 9);
  assert.ok(reserved.reservedMicroUsd >= 98);
});

test("unknown, fractional, negative and unsafe token bounds cannot become zero-cost admission", () => {
  for (const value of [undefined, null, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => ceilTokenMicroUsd(value, 1), /collector_token_count/);
    assert.throws(() => reserveCollectionCost(value, 1, [tier()]), /collector_context_unknown/);
    assert.throws(() => reserveCollectionCost(1, value, [tier()]), /collector_output_cap/);
  }
  assert.throws(() => reserveCollectionCost(0, 1, [tier()]), /collector_context_unknown/);
  assert.throws(() => reserveCollectionCost(1, 0, [tier()]), /collector_output_cap/);
  assert.throws(() => reserveCollectionCost(1, 1, []), /collector_price_tiers_missing/);
});

test("cost overflow and invalid rates fail rather than losing microUSD precision", () => {
  assert.throws(() => ceilTokenMicroUsd(Number.MAX_SAFE_INTEGER, 2), /collector_cost_overflow/);
  assert.throws(() => sumCollectionMoney([Number.MAX_SAFE_INTEGER, 1]), /collector_cost_overflow/);
  for (const value of [-1, 0.5, null, undefined, NaN, Infinity]) assert.throws(() => sumCollectionMoney([1, value]), /collector_money/);
  for (const value of [undefined, NaN, Infinity, -0.1]) assert.throws(() => ceilTokenMicroUsd(1, value), /collector_rate/);
});

test("invalid individual tier rates cannot be hidden by a higher valid tier", () => {
  for (const field of ["inputUsdPerMillionTokens", "outputUsdPerMillionTokens", "cacheWriteUsdPerMillionTokens", "cachedInputPriceMultiplier"]) {
    assert.throws(() => reserveCollectionCost(3, 1, [tier({ maxPromptTokens: 2 }), tier({ [field]: -0.1 })]), /collector_rate/, field);
  }
});

test("unobserved usage remains null rather than an inferred free call", () => {
  const empty = emptyCollectionObservation();
  assert.equal(estimateCollectionUsageCost(empty, pricedCall()), null);
  for (const key of ["inputTokens", "outputTokens", "noCacheInputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
    assert.equal(estimateCollectionUsageCost(observed({ [key]: null }), pricedCall()), null, key);
  }
  assert.equal(estimateCollectionUsageCost(observed({ unsupportedBilling: true }), pricedCall()), null);
  assert.equal(estimateCollectionUsageCost(observed({ inputTokens: 4 }), pricedCall()), null);
  assert.equal(estimateCollectionUsageCost(observed(), pricedCall([tier({ cacheWriteUsdPerMillionTokens: null })])), null);
  assert.equal(estimateCollectionUsageCost(observed({ inputTokens: 0, outputTokens: 0, noCacheInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), pricedCall()), 0,
    "an explicitly observed zero is distinct from unavailable usage");
});

test("complete oversized response preserves bare-hex digest through validator and JSON roundtrip", () => {
  const fullText = "한".repeat(Math.floor(COLLECTION_LIMITS.answerStorageBytes / 3) + 1);
  const outcome = returned("", {
    status: "measurement_unsupported", answerText: null, answerBytes: Buffer.byteLength(fullText),
    answerDigest: benchmarkDigest(fullText), textOmitted: true, failureCode: "answer_storage_limit",
  });
  assert.match(outcome.answerDigest, /^[a-f0-9]{64}$/);
  assert.ok(outcome.answerBytes > COLLECTION_LIMITS.answerStorageBytes);
  assert.deepEqual(validateCollectionOutcome(JSON.parse(canonicalBenchmarkJson(outcome))), outcome);
  assert.throws(() => validateCollectionOutcome({ ...outcome, answerDigest: `sha256:${outcome.answerDigest}` }), /collector_answer_omission/);
});

test("answer storage boundary uses UTF-8 bytes and never silently truncates", () => {
  const exact = "é".repeat(COLLECTION_LIMITS.answerStorageBytes / 2);
  assert.equal(validateCollectionOutcome(returned(exact)).answerBytes, COLLECTION_LIMITS.answerStorageBytes);
  assert.throws(() => validateCollectionOutcome(returned(`${exact}é`)), /collector_answer_integrity/);
  assert.throws(() => validateCollectionOutcome(returned("한", { answerBytes: 1 })), /collector_answer_integrity/);
  assert.throws(() => validateCollectionOutcome(returned("{}", { answerDigest: benchmarkDigest("[]") })), /collector_answer_integrity/);
});

test("partial response cannot claim a full omitted answer digest or complete byte count", () => {
  const unknown = returned("", { status: "unknown", answerText: null, answerBytes: null, answerDigest: null, completeResponse: false, failureCode: "connection_lost" });
  assert.deepEqual(validateCollectionOutcome(unknown), unknown);
  assert.throws(() => validateCollectionOutcome({ ...unknown, answerDigest: benchmarkDigest("partial") }), /collector_answer_omission/);
  assert.throws(() => validateCollectionOutcome({ ...unknown, answerBytes: COLLECTION_LIMITS.answerStorageBytes + 1, answerDigest: benchmarkDigest("partial"), textOmitted: true }), /collector_answer_omission/);
  assert.throws(() => validateCollectionOutcome({ ...unknown, status: "returned", failureCode: null }), /collector_returned_answer_missing/);
});

test("outcome validation preserves missing observations and rejects invalid numeric observations", () => {
  const outcome = validateCollectionOutcome(returned());
  assert.deepEqual(outcome.observation, emptyCollectionObservation());
  assert.equal(outcome.latencyMs, null);
  for (const key of ["inputTokens", "outputTokens", "noCacheInputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"]) {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      assert.throws(() => validateCollectionOutcome(returned("{}", { observation: observed({ [key]: value }) })), new RegExp(`collector_observation_${key}`));
    }
  }
  const missing = returned(); delete missing.observation.inputTokens;
  assert.throws(() => validateCollectionOutcome(missing), /unexpected_or_missing/);
});

test("failed and timeout outcomes cannot carry a successful answer", () => {
  for (const status of ["failed", "timeout"]) {
    assert.throws(() => validateCollectionOutcome(returned("{}", { status, failureCode: "request_failed" })), /collector_failure_answer/);
  }
  assert.throws(() => validateCollectionOutcome(returned("{}", { failureCode: "ignored_failure" })), /collector_returned_answer_missing/);
});

test("manifest selection leaves the full 24 by catalogue matrix and refused rows intact", () => {
  assert.equal(manifest.plan.rows.length, corpus.cases.length * AVAILABLE_MODELS.length);
  assert.equal(manifest.selectedRowIds.length, 2);
  assert.equal(manifest.plan.rows.filter((row) => !row.benchmarkEligibility.eligible).length, plan.rows.filter((row) => !row.benchmarkEligibility.eligible).length);
  const refused = plan.rows.find((row) => !row.benchmarkEligibility.eligible);
  assert.throws(() => buildCollectionManifest({ ...manifestInput, limits, selectedRowIds: [refused.rowId] }), /collector_row_refused_or_unknown/);
});

test("rehashed manifest edits cannot change frozen reservations, settings, or full row coverage", () => {
  assert.deepEqual(validateCollectionManifest(manifest, manifestInput), manifest);
  for (const mutate of [
    (value) => { value.calls[0].reserve.reservedMicroUsd = 0; },
    (value) => { value.calls[0].settings = { temperature: 99 }; },
    (value) => { value.plan.rows.pop(); },
    (value) => { value.collectorSource.commit = "f".repeat(40); },
  ]) {
    const altered = structuredClone(manifest); mutate(altered);
    const { manifestDigest: ignored, ...body } = altered; void ignored;
    altered.manifestDigest = collectionHash(body);
    assert.throws(() => validateCollectionManifest(altered, manifestInput), /collector_manifest_snapshot_mismatch/);
  }
});

test("synthetic approval is bound to exact manifest, acknowledgement order, and actor", () => {
  const approval = syntheticApproval();
  assert.deepEqual(validateCollectionApproval(approval, manifest, Date.parse(instant)), approval);
  for (const mutation of [
    { status: "proposal" }, { manifestDigest: "f".repeat(64) }, { approvedBy: " " },
    { expiresAt: "2026-09-10T00:02:00.000Z" },
    { acknowledgements: [...COLLECTION_ASSUMPTIONS].reverse() },
    { acknowledgements: COLLECTION_ASSUMPTIONS.slice(1) },
  ]) assert.throws(() => validateCollectionApproval({ ...approval, ...mutation }, manifest, Date.parse(instant)), /collector_approval_binding/);
  assert.throws(() => validateCollectionApproval({ ...approval, maxTotalMicroUsd: 99 }, manifest, Date.parse(instant)), /unexpected_or_missing/);
});

test("approval cannot become an unbounded or path-traversing identity", () => {
  for (const approvalId of ["../reset", "x/y", "x\\y", "", "UPPER", "x".repeat(65)]) {
    assert.throws(() => validateCollectionApproval({ ...syntheticApproval(), approvalId }, manifest, Date.parse(instant)), /collector_approval_id/);
  }
  for (const key of ["maxTotalMicroUsd", "maxRequestMicroUsd", "maxCalls", "requestTimeoutMs", "runTimeoutMs"]) {
    for (const value of [0, -1, null, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateCollectionLimits({ ...limits, [key]: value }), new RegExp(`collector_limit_${key}`));
  }
});

test("expired or future synthetic approval cannot authorize dispatch", () => {
  const approval = syntheticApproval();
  assert.throws(() => validateCollectionApproval(approval, manifest, Date.parse(limits.expiresAt)), /collector_approval_time/);
  assert.throws(() => validateCollectionApproval({ ...approval, approvedAt: "2026-09-10T00:00:01.000Z" }, manifest, Date.parse(instant)), /collector_approval_time/);
  assert.throws(() => validateCollectionApproval({ ...approval, approvedAt: "2026-09-09T23:59:59.000Z" }, manifest, Date.parse(instant)), /collector_approval_time/);
  assert.deepEqual(validateCollectionApproval(approval, manifest, Date.parse(limits.expiresAt), true), approval,
    "historical export validation may accept expiry without reauthorizing collection");
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function localFixture(t, target = manifest) {
  const directory = fs.mkdtempSync(join(tmpdir(), "router-collector-adversarial-fixture-"));
  t.after(() => {
    const safe = resolve(directory);
    assert.equal(dirname(safe), resolve(tmpdir()));
    assert.ok(basename(safe).startsWith("router-collector-adversarial-fixture-"));
    fs.rmSync(safe, { recursive: true, force: true });
  });
  const approval = syntheticApproval(target);
  const input = { manifest: target, approval, commonDir: directory, now: () => Date.parse(instant), assertCurrent: () => {} };
  const paths = collectorPaths(directory, approval.approvalId);
  return { directory, input, paths, state: () => replayCollectionJournal(readFileSync(paths.ledger, "utf8"), target, approval) };
}
const oneRowManifest = () => buildCollectionManifest({ ...manifestInput, limits, selectedRowIds: [eligible[0].rowId] });
function trackedIO(hooks = {}) {
  const opened = new Map();
  return {
    ...fs,
    openSync(path, ...args) { const fd = fs.openSync(path, ...args); opened.set(fd, String(path)); return fd; },
    closeSync(fd) { opened.delete(fd); return fs.closeSync(fd); },
    writeSync(fd, ...args) { return hooks.write ? hooks.write(opened.get(fd), fd, ...args) : fs.writeSync(fd, ...args); },
    fsyncSync(fd) { return hooks.flush ? hooks.flush(opened.get(fd), fd) : fs.fsyncSync(fd); },
  };
}
function encodeEvents(events) {
  let previousDigest = null;
  return events.map((event, seq) => {
    const body = { seq, previousDigest, event };
    const entryDigest = collectionHash(body);
    previousDigest = entryDigest;
    return canonicalBenchmarkJson({ ...body, entryDigest });
  }).join("\n") + "\n";
}
const historyEvents = (target = manifest) => [
  { kind: "header", approvalDigest: collectionHash(syntheticApproval(target)), manifestDigest: target.manifestDigest, startedAt: instant },
  { kind: "intent", rowId: target.calls[0].rowId, at: instant, reservedMicroUsd: target.calls[0].reserve.reservedMicroUsd },
  { kind: "terminal", rowId: target.calls[0].rowId, at: instant, outcome: returned(), tokenUsageAtFrozenRatesMicroUsd: null },
];

test("partial writes loop to completion and flush before returning", (t) => {
  const fix = localFixture(t);
  const path = join(fix.directory, "synthetic-short-write.jsonl");
  const order = [];
  const io = trackedIO({
    write(file, fd, buffer, offset, length, position) { order.push("write"); return fs.writeSync(fd, buffer, offset, Math.min(3, length), position); },
    flush(file, fd) { order.push("flush"); fs.fsyncSync(fd); },
  });
  writeCollectionDurably(path, "한글 synthetic fixture\n", "wx", io);
  assert.equal(readFileSync(path, "utf8"), "한글 synthetic fixture\n");
  assert.ok(order.filter((event) => event === "write").length > 1);
  assert.equal(order.at(-1), "flush");
  assert.equal(order.filter((event) => event === "flush").length, 1);
});

test("registration followed by missing ledger fails closed without a replacement budget", async (t) => {
  const fix = localFixture(t);
  let dispatches = 0;
  let failHeader = true;
  const io = trackedIO({ write(path, fd, ...args) {
    if (path === fix.paths.ledger && failHeader) { failHeader = false; throw new Error("synthetic_header_write_failure"); }
    return fs.writeSync(fd, ...args);
  } });
  await assert.rejects(collectDevelopment({ ...fix.input, io, adapter: async () => { dispatches += 1; return returned(); } }), /synthetic_header_write_failure/);
  assert.ok(fs.existsSync(fix.paths.registration));
  if (fs.existsSync(fix.paths.ledger)) fs.unlinkSync(fix.paths.ledger); // Simulate lost local state, only inside this test's temp directory.
  const before = readFileSync(fix.paths.registration);
  await assert.rejects(collectDevelopment({ ...fix.input, adapter: async () => { dispatches += 1; return returned(); } }), /collector_registered_ledger_missing/);
  assert.equal(dispatches, 0);
  assert.equal(fs.existsSync(fix.paths.ledger), false);
  assert.deepEqual(readFileSync(fix.paths.registration), before);
});

test("intent journal fsync failure happens before dispatch and cannot be resumed as fresh", async (t) => {
  const fix = localFixture(t);
  let dispatches = 0;
  let ledgerFlushes = 0;
  const io = trackedIO({ flush(path, fd) {
    if (path === fix.paths.ledger && ++ledgerFlushes === 2) throw new Error("synthetic_intent_fsync_failure");
    fs.fsyncSync(fd);
  } });
  const adapter = async () => { dispatches += 1; return returned(); };
  await assert.rejects(collectDevelopment({ ...fix.input, io, adapter }), /synthetic_intent_fsync_failure/);
  assert.equal(dispatches, 0);
  assert.equal(fix.state().unknownRows.length, 1);
  assert.ok(fix.state().totalReservedMicroUsd > 0);
  await assert.rejects(collectDevelopment({ ...fix.input, adapter }), /collector_journal_witness_mismatch/);
  assert.equal(dispatches, 0);
});

test("intent witness fsync failure still cannot precede a provider call", async (t) => {
  const fix = localFixture(t);
  let registrationFlushes = 0;
  let dispatches = 0;
  const io = trackedIO({ flush(path, fd) {
    if (path === fix.paths.registration && ++registrationFlushes === 3) throw new Error("synthetic_witness_fsync_failure");
    fs.fsyncSync(fd);
  } });
  await assert.rejects(collectDevelopment({ ...fix.input, io, adapter: async () => { dispatches += 1; return returned(); } }), /synthetic_witness_fsync_failure/);
  assert.equal(dispatches, 0);
  const resumed = await collectDevelopment({ ...fix.input, adapter: async () => { dispatches += 1; return returned(); } });
  assert.equal(resumed.stopReason, "unknown_after_dispatch");
  assert.equal(resumed.dispatchIntents, 1);
  assert.equal(dispatches, 0);
});

for (const point of ["intent_durable", "response_received"]) {
  test(`interruption at ${point} holds reservation, prevents redispatch, and refuses export`, async (t) => {
    const fix = localFixture(t);
    let dispatches = 0;
    const adapter = async () => { dispatches += 1; return returned(); };
    await assert.rejects(collectDevelopment({ ...fix.input, adapter, onCheckpoint(checkpoint) { if (checkpoint === point) throw new Error("synthetic_checkpoint_interruption"); } }), /synthetic_checkpoint_interruption/);
    const before = fix.state();
    assert.equal(before.attempts.size, 1);
    assert.equal(before.unknownRows.length, 1);
    assert.equal([...before.attempts.values()][0].terminal, null);
    const resumed = await collectDevelopment({ ...fix.input, adapter });
    assert.equal(dispatches, point === "intent_durable" ? 0 : 1);
    assert.equal(resumed.stopReason, "unknown_after_dispatch");
    assert.equal(resumed.committedReservationMicroUsd, before.totalReservedMicroUsd);
    assert.equal(resumed.actualInvoiceMicroUsd, null);
    assert.equal(resumed.rows.find((row) => row.rowId === before.unknownRows[0]).outcome, "unknown_after_dispatch");
    await assert.rejects(exportDevelopmentCollection(fix.input), /collector_export_uncertain_or_unsupported/);
  });
}

test("same approval ID cannot reset spending through another path or enlarged manifest", async (t) => {
  const fix = localFixture(t, oneRowManifest());
  let dispatches = 0;
  const adapter = async () => { dispatches += 1; return returned(); };
  const first = await collectDevelopment({ ...fix.input, adapter });
  const second = await collectDevelopment({ ...fix.input, commonDir: resolve(fix.directory, "unused-output", ".."), adapter });
  assert.equal(dispatches, 1);
  assert.equal(second.committedReservationMicroUsd, first.committedReservationMicroUsd);
  const changed = buildCollectionManifest({ ...manifestInput, selectedRowIds: [eligible[0].rowId], limits: { ...limits, maxTotalMicroUsd: limits.maxTotalMicroUsd + 1 } });
  await assert.rejects(collectDevelopment({ ...fix.input, manifest: changed, approval: syntheticApproval(changed), adapter }), /collector_registration_identity/);
  assert.equal(dispatches, 1);
});

test("two writers sharing one approval cannot both dispatch while the lock is held", async (t) => {
  const fix = localFixture(t, oneRowManifest());
  let entered;
  const inAdapter = new Promise((resolveEntered) => { entered = resolveEntered; });
  let release;
  const held = new Promise((resolveHeld) => { release = resolveHeld; });
  let dispatches = 0;
  const first = collectDevelopment({ ...fix.input, adapter: async () => { dispatches += 1; entered(); await held; return returned(); } });
  await inAdapter;
  try {
    await assert.rejects(collectDevelopment({ ...fix.input, adapter: async () => { dispatches += 1; return returned(); } }), /collector_lock_unavailable_no_stale_recovery/);
    assert.equal(dispatches, 1);
  } finally { release(); await first; }
  assert.equal(fix.state().attempts.size, 1);
  assert.equal(fix.state().totalReservedMicroUsd, fix.input.manifest.calls[0].reserve.reservedMicroUsd);
});

test("terminal fsync failure cannot be exported as a witnessed successful completion", async (t) => {
  const fix = localFixture(t);
  let flushes = 0;
  let dispatches = 0;
  const io = trackedIO({ flush(path, fd) {
    if (path === fix.paths.ledger && ++flushes === 3) throw new Error("synthetic_terminal_fsync_failure");
    fs.fsyncSync(fd);
  } });
  const adapter = async () => { dispatches += 1; return returned(); };
  await assert.rejects(collectDevelopment({ ...fix.input, adapter, io }), /synthetic_terminal_fsync_failure/);
  await assert.rejects(exportDevelopmentCollection(fix.input), /collector_journal_witness_mismatch/);
  await assert.rejects(collectDevelopment({ ...fix.input, adapter }), /collector_journal_witness_mismatch/);
  assert.equal(dispatches, 1);
});

test("a valid older ledger prefix cannot erase witnessed dispatch history", async (t) => {
  const fix = localFixture(t, oneRowManifest());
  await collectDevelopment({ ...fix.input, adapter: async () => returned() });
  const header = readFileSync(fix.paths.ledger, "utf8").split("\n")[0] + "\n";
  fs.writeFileSync(fix.paths.ledger, header);
  let dispatches = 0;
  await assert.rejects(collectDevelopment({ ...fix.input, adapter: async () => { dispatches += 1; return returned(); } }), /collector_journal_witness_mismatch/);
  await assert.rejects(exportDevelopmentCollection(fix.input), /collector_journal_witness_mismatch/);
  assert.equal(dispatches, 0);
});

test("journal parser rejects truncation, duplicated terminals, and rehashed identity mutations", () => {
  const events = historyEvents();
  const text = encodeEvents(events);
  assert.equal(replayCollectionJournal(text, manifest, syntheticApproval()).attempts.size, 1);
  assert.throws(() => replayCollectionJournal(text.slice(0, -1), manifest, syntheticApproval()), /collector_journal_truncated/);
  assert.throws(() => replayCollectionJournal(text + "\n", manifest, syntheticApproval()), /collector_journal_blank_line/);
  assert.throws(() => replayCollectionJournal(encodeEvents([...events, events[2]]), manifest, syntheticApproval()), /collector_duplicate_or_orphan_terminal/);
  assert.throws(() => replayCollectionJournal(encodeEvents([events[0], events[2]]), manifest, syntheticApproval()), /collector_duplicate_or_orphan_terminal/);
  assert.throws(() => replayCollectionJournal(encodeEvents([events[0], events[1], events[1]]), manifest, syntheticApproval()), /collector_duplicate_or_forged_intent/);
  for (const field of ["approvalDigest", "manifestDigest"]) {
    assert.throws(() => replayCollectionJournal(encodeEvents([{ ...events[0], [field]: "f".repeat(64) }, ...events.slice(1)]), manifest, syntheticApproval()), /collector_journal_identity/);
  }
  assert.throws(() => replayCollectionJournal(encodeEvents([events[0], { ...events[1], reservedMicroUsd: 0 }]), manifest, syntheticApproval()), /collector_duplicate_or_forged_intent/);
  assert.throws(() => replayCollectionJournal(encodeEvents([events[0], events[1], { ...events[2], tokenUsageAtFrozenRatesMicroUsd: 0 }]), manifest, syntheticApproval()), /collector_journal_cost_forged/);
});

test("current-snapshot guard executes again before a later dispatch after clock advancement", async (t) => {
  const fix = localFixture(t);
  let dispatches = 0;
  let now = Date.parse(instant);
  const frozenRevisionEnd = now + 1;
  const assertions = [];
  await assert.rejects(collectDevelopment({ ...fix.input, now: () => now, assertCurrent() {
    assertions.push(now);
    if (now >= frozenRevisionEnd) throw new Error("synthetic_known_price_revision_boundary");
  }, adapter: async () => { dispatches += 1; now += 2; return returned(); } }), /synthetic_known_price_revision_boundary/);
  assert.equal(dispatches, 1);
  assert.deepEqual(assertions, [Date.parse(instant), Date.parse(instant), Date.parse(instant), now],
    "entry, pre-intent, post-intent, then next-row pre-intent must all assert the current snapshot");
  assert.equal(fix.state().attempts.size, 1);
  // This is the journal injection contract, not evidence that the CLI pricing guard is correct.
});

test("time spent durably recording intent cannot extend approval past its expiry", async (t) => {
  const fix = localFixture(t, oneRowManifest());
  let now = Date.parse(instant);
  let dispatches = 0;
  let result;
  let failure;
  try {
    result = await collectDevelopment({ ...fix.input, now: () => now,
      onCheckpoint(point) { if (point === "intent_durable") now = Date.parse(limits.expiresAt); },
      adapter: async () => { dispatches += 1; return returned(); },
    });
  } catch (error) { failure = error; }
  assert.equal(dispatches, 0, "a stale pre-fsync remainingMs must never authorize a post-expiry dispatch");
  assert.equal(fix.state().attempts.size, 1);
  assert.equal(fix.state().unknownRows.length, 1);
  assert.ok(fix.state().totalReservedMicroUsd > 0);
  if (failure) assert.match(failure.message, /^collector_/);
  else assert.ok(result.stopReason, "durable but undispatched intent needs an explicit stopped/unknown state");
});

test("a price revision crossed during intent persistence is checked before dispatch", async (t) => {
  const fix = localFixture(t, oneRowManifest());
  let now = Date.parse(instant);
  const revisionBoundary = now + 1;
  let dispatches = 0;
  const result = collectDevelopment({ ...fix.input, now: () => now,
    assertCurrent() { if (now >= revisionBoundary) throw new Error("synthetic_price_revision_during_fsync"); },
    onCheckpoint(point) { if (point === "intent_durable") now += 2; },
    adapter: async () => { dispatches += 1; return returned(); },
  });
  await assert.rejects(result, /synthetic_price_revision_during_fsync/);
  assert.equal(dispatches, 0);
  assert.equal(fix.state().unknownRows.length, 1);
});

test("collector adapter request contains only prompt and frozen call settings, never gold", async (t) => {
  const fix = localFixture(t, oneRowManifest());
  await collectDevelopment({ ...fix.input, adapter: async (request) => {
    assert.deepEqual(Object.keys(request).sort(), ["maxOutputTokens", "modelId", "prompt", "settings", "signal"]);
    const row = fix.input.manifest.plan.rows.find((candidate) => candidate.rowId === fix.input.manifest.calls[0].rowId);
    assert.equal(request.prompt, corpus.cases.find((item) => item.id === row.caseId).prompt);
    assert.equal(request.maxOutputTokens, row.callConfig.proposedMaxOutputTokens);
    assert.deepEqual(request.settings, fix.input.manifest.calls[0].settings);
    for (const key of ["expected", "grading", "corpus", "caseId", "rowId", "approval", "manifest"]) assert.equal(Object.hasOwn(request, key), false);
    return returned();
  } });
});

for (const kind of ["unknown", "storage_omitted", "v1_answer_oversized"]) {
  test(`v1 export refuses ${kind} without discarding the attempted row`, async (t) => {
    const fix = localFixture(t, oneRowManifest());
    const outcome = kind === "unknown"
      ? returned("", { status: "unknown", answerText: null, answerBytes: null, answerDigest: null, completeResponse: false, failureCode: "transport_lost" })
      : collectionReturnedOutcome("openai", null, "x".repeat(kind === "storage_omitted" ? COLLECTION_LIMITS.answerStorageBytes + 1 : DEVELOPMENT_LIMITS.answerBytes + 1), 1);
    const report = await collectDevelopment({ ...fix.input, adapter: async () => outcome });
    assert.equal(report.dispatchIntents, 1);
    assert.equal(report.rows.length, plan.rows.length);
    assert.notEqual(report.rows.find((row) => row.rowId === fix.input.manifest.calls[0].rowId).outcome, "not_run");
    assert.ok(report.committedReservationMicroUsd > 0);
    assert.equal(report.actualInvoiceMicroUsd, null);
    await assert.rejects(exportDevelopmentCollection(fix.input), /collector_export_uncertain_or_unsupported/);
  });
}

test("export preserves blank and failed rows in the original eligible denominator", async (t) => {
  const fix = localFixture(t);
  let calls = 0;
  await collectDevelopment({ ...fix.input, adapter: async () => ++calls === 1 ? returned("") : returned("", { status: "failed", answerText: null, answerBytes: null, answerDigest: null, failureCode: "provider_http_error" }) });
  const results = await exportDevelopmentCollection(fix.input);
  const score = scoreDevelopmentResults(corpus, plan, results);
  assert.equal(results.rows.length, 2);
  assert.equal(score.summary.planned, eligible.length);
  assert.equal(score.summary.blank, 1);
  assert.equal(score.summary.failed, 1);
  assert.equal(score.summary.notRun, eligible.length - 2);
  assert.equal(score.summary.correctnessRate, null);
  assert.equal(score.reportedMetrics.providerCostUsd.total, null);
  for (const row of results.rows) assert.equal(row.metrics.providerCostUsd, null);
});

test("controlled timeout terminal is exported as timeout without releasing its reservation", async (t) => {
  const fix = localFixture(t, oneRowManifest());
  const outcome = returned("", { status: "timeout", answerText: null, answerBytes: null, answerDigest: null, completeResponse: false, failureCode: "deadline_abort_billing_unknown" });
  const report = await collectDevelopment({ ...fix.input, adapter: async () => outcome });
  const results = await exportDevelopmentCollection(fix.input);
  assert.equal(results.rows.length, 1);
  assert.equal(results.rows[0].status, "timeout");
  assert.equal(results.rows[0].metrics.providerCostUsd, null);
  assert.equal(scoreDevelopmentResults(corpus, plan, results).summary.timeout, 1);
  assert.equal(scoreDevelopmentResults(corpus, plan, results).summary.planned, eligible.length);
  assert.ok(report.committedReservationMicroUsd > 0);
  assert.equal(report.actualInvoiceMicroUsd, null);
});

test("durable timeout stops later rows and resume while remaining exportable as timeout", async (t) => {
  const fix = localFixture(t);
  let calls = 0;
  const adapter = async () => {
    calls += 1;
    return returned("", { status: "timeout", answerText: null, answerBytes: null, answerDigest: null, completeResponse: false, failureCode: "deadline_abort_billing_unknown" });
  };
  const first = await collectDevelopment({ ...fix.input, adapter });
  assert.equal(calls, 1, "a controlled timeout must stop subsequent selected rows");
  assert.ok(first.stopReason);
  assert.equal(first.dispatchIntents, 1);
  const resumed = await collectDevelopment({ ...fix.input, adapter });
  assert.equal(calls, 1, "resume must not continue past a durable timeout");
  assert.equal(resumed.committedReservationMicroUsd, first.committedReservationMicroUsd);
  const results = await exportDevelopmentCollection(fix.input);
  assert.equal(results.rows.length, 1);
  assert.equal(results.rows[0].status, "timeout");
  const score = scoreDevelopmentResults(corpus, plan, results);
  assert.equal(score.summary.timeout, 1);
  assert.equal(score.summary.notRun, eligible.length - 1);
  assert.equal(score.summary.planned, eligible.length);
});

test("whole-document v1 export limit refuses rather than dropping large valid rows", async (t) => {
  const target = buildCollectionManifest({ ...manifestInput, selectedRowIds: eligible.map((row) => row.rowId), limits: { ...limits, maxTotalMicroUsd: 1_000_000_000_000 } });
  const fix = localFixture(t, target);
  const events = [historyEvents(target)[0]];
  const answer = returned("x".repeat(DEVELOPMENT_LIMITS.answerBytes));
  for (const call of target.calls) {
    events.push({ kind: "intent", rowId: call.rowId, at: instant, reservedMicroUsd: call.reserve.reservedMicroUsd });
    events.push({ kind: "terminal", rowId: call.rowId, at: instant, outcome: answer, tokenUsageAtFrozenRatesMicroUsd: null });
  }
  const journal = encodeEvents(events);
  const entries = journal.trimEnd().split("\n").map((line) => JSON.parse(line));
  fs.mkdirSync(fix.paths.root);
  fs.writeFileSync(fix.paths.ledger, journal);
  const registration = { schemaVersion: COLLECTION_VERSION, approvalId: fix.input.approval.approvalId, approvalDigest: collectionHash(fix.input.approval), manifestDigest: target.manifestDigest };
  fs.writeFileSync(fix.paths.registration, [registration, ...entries.map(({ seq, entryDigest }) => ({ seq, entryDigest }))].map((entry) => canonicalBenchmarkJson(entry)).join("\n") + "\n");
  assert.ok(Buffer.byteLength(journal) > DEVELOPMENT_LIMITS.documentBytes);
  await assert.rejects(exportDevelopmentCollection(fix.input), /collector_export_document_limit/);
  assert.equal(fix.state().attempts.size, eligible.length);
});

// A temporary child imports production journal code, but only a local fake adapter.
// Reference: tests/aiReviewDraftLedgerCli.test.mjs:258 (abrupt exit), :315 (race).
function childHarness(fix, mode) {
  const fixturePath = join(fix.directory, "synthetic-fixture-not-an-approval.json");
  const helperPath = join(fix.directory, "synthetic-child.mjs");
  const tracePath = join(fix.directory, "fake-dispatches.jsonl");
  if (!fs.existsSync(fixturePath)) fs.writeFileSync(fixturePath, JSON.stringify({ manifest: fix.input.manifest, approval: fix.input.approval, commonDir: fix.directory, instant, tracePath }));
  if (!fs.existsSync(helperPath)) fs.writeFileSync(helperPath, `
import fs from 'node:fs';
import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
import tls from 'node:tls'; import dgram from 'node:dgram'; import { syncBuiltinESMExports } from 'node:module';
const refused=()=>{throw new Error('ADVERSARIAL_CHILD_NETWORK_FORBIDDEN');};
globalThis.fetch=refused; http.request=refused; http.get=refused; https.request=refused; https.get=refused;
net.connect=refused; net.createConnection=refused; net.Socket.prototype.connect=refused; tls.connect=refused; dgram.createSocket=refused; syncBuiltinESMExports();
const {collectDevelopment}=await import(${JSON.stringify(pathToFileURL(join(root, "lib/routerDevelopmentCollectorJournal.ts")).href)});
const {emptyCollectionObservation}=await import(${JSON.stringify(pathToFileURL(join(root, "lib/routerDevelopmentCollector.ts")).href)});
const {benchmarkDigest}=await import(${JSON.stringify(pathToFileURL(join(root, "lib/routerDevelopmentBenchmark.ts")).href)});
const fixture=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); const mode=process.argv[3];
try {
  const report=await collectDevelopment({...fixture, now:()=>Date.parse(fixture.instant), assertCurrent:()=>{},
    onCheckpoint(point){if(mode===point) process.exit(73);},
    adapter:async()=>{
      fs.appendFileSync(fixture.tracePath,JSON.stringify({synthetic:true})+'\\n');
      if(mode==='hold'){await new Promise(resolve=>{process.once('message',resolve); process.send({kind:'entered'});});}
      return {status:'returned',answerText:'{}',answerBytes:2,answerDigest:benchmarkDigest('{}'),textOmitted:false,completeResponse:true,failureCode:null,latencyMs:null,observation:emptyCollectionObservation()};
    }});
  process.send({kind:'done',dispatchIntents:report.dispatchIntents}); process.disconnect();
} catch(error) {process.send({kind:'error',message:error.message}); process.disconnect(); process.exitCode=2;}
`);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|comspec|temp|tmp|pathext)$/i.test(key)));
  const child = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", helperPath, fixturePath, mode], {
    cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
  });
  const messages = [];
  let stderr = "";
  child.on("message", (message) => messages.push(message));
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.resume();
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const closed = new Promise((resolveClosed, rejectClosed) => {
    child.once("error", rejectClosed);
    child.once("close", (code, signal) => { clearTimeout(timer); resolveClosed({ code, signal, messages, stderr }); });
  });
  return { child, closed, tracePath };
}

for (const point of ["intent_durable", "response_received"]) {
  test(`real child abrupt exit at ${point} leaves an unknown intent and an unreclaimed lock`, { timeout: 20_000 }, async (t) => {
    const fix = localFixture(t, oneRowManifest());
    const child = childHarness(fix, point);
    const result = await child.closed;
    assert.equal(result.code, 73, result.stderr);
    assert.equal(result.signal, null);
    assert.ok(fs.existsSync(fix.paths.lock));
    const state = fix.state();
    assert.equal(state.attempts.size, 1);
    assert.equal(state.unknownRows.length, 1);
    assert.ok(state.totalReservedMicroUsd > 0);
    const calls = fs.existsSync(child.tracePath) ? readFileSync(child.tracePath, "utf8").trimEnd().split("\n").length : 0;
    assert.equal(calls, point === "intent_durable" ? 0 : 1);
    await assert.rejects(collectDevelopment({ ...fix.input, adapter: async () => assert.fail("stale-lock redispatch") }), /collector_lock_unavailable_no_stale_recovery/);
    await assert.rejects(exportDevelopmentCollection(fix.input), /collector_lock_unavailable_no_stale_recovery/);
  });
}

test("separate child writers cannot double-spend a shared approval journal", { timeout: 25_000 }, async (t) => {
  const fix = localFixture(t, oneRowManifest());
  const first = childHarness(fix, "hold");
  let second;
  try {
    const [message] = await once(first.child, "message");
    assert.equal(message.kind, "entered");
    second = childHarness(fix, "complete");
    const blocked = await second.closed;
    assert.equal(blocked.code, 2, blocked.stderr);
    assert.match(blocked.messages.find((entry) => entry.kind === "error")?.message ?? "", /collector_lock_unavailable_no_stale_recovery/);
    first.child.send({ kind: "release" });
    const completed = await first.closed;
    assert.equal(completed.code, 0, completed.stderr);
    assert.equal(readFileSync(first.tracePath, "utf8").trimEnd().split("\n").length, 1);
    assert.equal(fix.state().attempts.size, 1);
    assert.equal(fix.state().totalReservedMicroUsd, fix.input.manifest.calls[0].reserve.reservedMicroUsd);
  } finally {
    for (const processState of [first, second].filter(Boolean)) {
      if (processState.child.exitCode === null && processState.child.signalCode === null) processState.child.kill("SIGKILL");
      await processState.closed;
    }
  }
});

function sdkRequest() {
  const call = manifest.calls[0];
  const row = plan.rows.find((candidate) => candidate.rowId === call.rowId);
  return { modelId: row.modelId, prompt: row.input.prompt, settings: call.settings, maxOutputTokens: row.callConfig.proposedMaxOutputTokens, signal: new AbortController().signal };
}

test("SDK options force retry zero, one prompt, frozen output cap, and raw-body opt-in", async () => {
  const request = sdkRequest();
  let calls = 0;
  const fakeModel = { syntheticModel: true };
  const adapter = createCollectionSdkAdapter({ getModel: () => fakeModel, getSettings: () => request.settings, now: () => 0,
    generate: async (options) => {
      calls += 1;
      assert.deepEqual(Object.keys(options).sort(), [...new Set(["model", ...Object.keys(request.settings), "prompt", "maxOutputTokens", "maxRetries", "abortSignal", "include"])].sort());
      assert.equal(options.model, fakeModel);
      assert.equal(options.prompt, request.prompt);
      assert.equal(options.maxRetries, 0);
      assert.equal(options.maxOutputTokens, request.maxOutputTokens);
      assert.equal(options.abortSignal, request.signal);
      assert.deepEqual(options.include, { responseBody: true });
      return { text: "{}", steps: [{}], finalStep: { response: {} }, usage: { inputTokens: 0, outputTokens: 0 }, response: { id: "sdk-invented-id", modelId: "sdk-default-model" } };
    },
  });
  const outcome = await adapter(request);
  assert.equal(calls, 1);
  assert.deepEqual(outcome.observation, emptyCollectionObservation(), "SDK normalized zeros and synthesized IDs are not raw observations");
});

test("retryable SDK provider error dispatches exactly once with the real SDK and a mock model", async () => {
  // Installed SDK's public mock seam; no provider transport is constructed.
  // Reference: node_modules/ai/src/test/mock-language-model-v4.ts:20.
  const { generateText, APICallError } = await import("ai");
  const { MockLanguageModelV4 } = await import("ai/test");
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    throw new APICallError({ message: "synthetic retryable failure", url: "https://example.invalid", requestBodyValues: {}, statusCode: 503, responseBody: "{}", isRetryable: true });
  } });
  const request = sdkRequest();
  const adapter = createCollectionSdkAdapter({ generate: generateText, getModel: () => model, getSettings: () => request.settings, now: () => 0 });
  const outcome = await adapter(request);
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(model.doStreamCalls.length, 0);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failureCode, "provider_http_error");
  assert.equal(outcome.observation.inputTokens, null);
});

test("SDK settings drift refuses before model construction or generation", async () => {
  const request = sdkRequest();
  let calls = 0;
  const adapter = createCollectionSdkAdapter({ getSettings: () => ({ temperature: 99 }),
    getModel: () => { calls += 1; return {}; }, generate: async () => { calls += 1; return {}; },
  });
  await assert.rejects(adapter(request), /collector_provider_settings_drift/);
  assert.equal(calls, 0);
});

test("multi-step and tool-bearing replies remain unsupported even with an answer", async () => {
  const request = sdkRequest();
  const adapter = createCollectionSdkAdapter({ getModel: () => ({}), getSettings: () => request.settings,
    generate: async () => ({ text: "{}", finalStep: { response: {} }, steps: [{}, {}] }), now: () => 0,
  });
  const multi = await adapter(request);
  assert.equal(multi.status, "measurement_unsupported");
  assert.equal(multi.answerText, "{}");
  assert.equal(multi.failureCode, "multiple_or_missing_steps");
  const tools = collectionReturnedOutcome("openai", { status: "completed", output: [{ type: "web_search_call" }] }, "{}", 0);
  assert.equal(tools.status, "measurement_unsupported");
  assert.equal(tools.observation.unsupportedBilling, true);
});

test("provider raw usage allowlist distinguishes missing, invalid, and observed zero", () => {
  const bodies = [
    ["openai", { usage: { input_tokens: 0, output_tokens: 0 }, status: "completed" }],
    ["xai", { usage: { prompt_tokens: 0, completion_tokens: 0 }, choices: [{ finish_reason: "stop" }] }],
    ["anthropic", { usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "end_turn" }],
    ["google", { usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 }, candidates: [{ finishReason: "STOP" }] }],
  ];
  for (const [provider, body] of bodies) {
    const observation = observeCollectionBody(provider, body);
    assert.equal(observation.providerResponseId, null);
    assert.equal(observation.providerReportedModel, null);
    assert.equal(observation.cacheWriteTokens, null);
    assert.equal(observation.reasoningTokens, null);
    assert.equal(estimateCollectionUsageCost(observation, pricedCall()), null);
  }
  assert.equal(observeCollectionBody("google", bodies[3][1]).outputTokens, null, "missing thoughts do not imply zero reasoning");
  for (const input_tokens of [-1, 0.5, "0", Number.MAX_SAFE_INTEGER + 1, NaN]) {
    assert.equal(observeCollectionBody("openai", { usage: { input_tokens } }).inputTokens, null);
  }
  const deepseek = observeCollectionBody("deepseek", { usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 8 } } });
  assert.equal(deepseek.cacheReadTokens, null, "a product-synthesized field is not DeepSeek original wire evidence");
});

test("provider failures do not persist secrets, request bodies, reasoning, or raw errors", async () => {
  const request = sdkRequest();
  const secret = "SYNTHETIC_SECRET_MUST_NOT_PERSIST";
  const adapter = createCollectionSdkAdapter({ getModel: () => ({}), getSettings: () => request.settings, now: () => 0,
    generate: async () => { throw Object.assign(new Error(secret), { statusCode: 403, requestBodyValues: { prompt: secret }, responseHeaders: { authorization: secret }, responseBody: JSON.stringify({ id: "safe-provider-id", private_reasoning: secret, error: { message: secret } }) }); },
  });
  const outcome = await adapter(request);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failureCode, "provider_http_error");
  assert.equal(JSON.stringify(outcome).includes(secret), false);
  assert.equal(outcome.observation.inputTokens, null);
});
