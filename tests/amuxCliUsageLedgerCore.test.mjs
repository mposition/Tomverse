import assert from "node:assert/strict";
import test from "node:test";

import { inspectAmuxCliUsageLedgerEvent } from "../lib/amux/cliUsageLedgerCore.ts";

const uuid = "123e4567-e89b-42d3-a456-426614174000";
const counts = (inputTokens, outputTokens, cacheReadInputTokens = 0, cacheCreationInputTokens = 0) => ({
  inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
  reasoningOutputTokens: null,
});
const claude = () => ({
  version: 1,
  invocationId: uuid,
  context: { kind: "worker", cardId: "card-1", taskId: "task-1", runId: "run-1",
    attemptId: "attempt-1", workerId: "review-worker" },
  cli: "claude", cliVersion: "2.1.286", authKind: "subscription",
  selectedModelId: "claude-opus-5-5",
  startedAt: "2026-10-02T00:00:00.000Z",
  endedAt: "2026-10-02T00:01:00.000Z", status: "succeeded",
  observation: {
    version: 1, cli: "claude", completeness: "reported_complete",
    observed: counts(25, 10, 5, 2), completedTurns: 2,
    inputTokensIncludeCacheRead: false, inputTokensIncludeCacheWrite: false,
    reasoningOutputIncludedInOutput: null,
    models: [{ modelId: "claude-opus-5-5", observed: counts(25, 10, 5, 2) }],
  },
});

test("bounded receipt accepts model-reported worker usage without the raw CLI result", () => {
  const inspected = inspectAmuxCliUsageLedgerEvent(claude());
  assert.ok(inspected);
  assert.match(inspected.receiptDigest, /^[a-f0-9]{64}$/);
  assert.equal(inspected.event.observation.observed.inputTokens, 25);
  assert.equal(inspected.event.context.kind, "worker");
  assert.deepEqual(inspectAmuxCliUsageLedgerEvent(claude()), inspected);
  const reordered = claude();
  reordered.context = Object.fromEntries(Object.entries(reordered.context).reverse());
  reordered.observation.observed = Object.fromEntries(Object.entries(reordered.observation.observed).reverse());
  reordered.observation.models[0].observed = Object.fromEntries(
    Object.entries(reordered.observation.models[0].observed).reverse());
  assert.equal(inspectAmuxCliUsageLedgerEvent(reordered)?.receiptDigest, inspected.receiptDigest,
    "semantic identity must not depend on JSON property insertion order");
});

test("Claude model map order does not alter an invocation receipt", () => {
  const first = claude();
  first.observation.models = [
    { modelId: "claude-fable-5-1", observed: counts(10, 4, 2, 1) },
    { modelId: "claude-opus-5-5", observed: counts(15, 6, 3, 1) },
  ];
  const second = structuredClone(first);
  second.observation.models.reverse();
  assert.equal(inspectAmuxCliUsageLedgerEvent(first)?.receiptDigest,
    inspectAmuxCliUsageLedgerEvent(second)?.receiptDigest);
});

test("idea analysis can retain an unknown observation without inventing zero spend", () => {
  const event = claude();
  event.context = { kind: "idea_analysis", ideaId: "idea-1", chunkIndex: 0, agentId: "amux-intake" };
  event.status = "outcome_unknown";
  event.observation = {
    ...event.observation, completeness: "unknown", observed: null,
    completedTurns: 0, models: [],
  };
  const inspected = inspectAmuxCliUsageLedgerEvent(event);
  assert.ok(inspected);
  assert.equal(inspected.event.observation.observed, null);
  assert.equal(inspected.event.status, "outcome_unknown");
});

test("Codex selected model is not fabricated as an attested served model", () => {
  const event = claude();
  event.cli = "codex";
  event.cliVersion = "0.155.1";
  event.selectedModelId = "gpt-6-astra";
  event.observation = {
    ...event.observation, cli: "codex", completedTurns: 1,
    observed: { ...counts(100, 30, 20, null), reasoningOutputTokens: 8 },
    models: [], inputTokensIncludeCacheRead: true,
    inputTokensIncludeCacheWrite: null,
    reasoningOutputIncludedInOutput: true,
  };
  const inspected = inspectAmuxCliUsageLedgerEvent(event);
  assert.ok(inspected);
  assert.deepEqual(inspected.event.observation.models, []);
  assert.equal(inspected.event.selectedModelId, "gpt-6-astra");
  const reportedCacheWrite = structuredClone(event);
  reportedCacheWrite.observation.observed.cacheCreationInputTokens = 7;
  assert.ok(inspectAmuxCliUsageLedgerEvent(reportedCacheWrite),
    "Codex accepts a raw cache_write_input_tokens count while its input inclusion stays unknown");
  const cacheOnly = structuredClone(event);
  cacheOnly.observation.observed = { ...cacheOnly.observation.observed,
    inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 7,
    reasoningOutputTokens: 0 };
  assert.equal(inspectAmuxCliUsageLedgerEvent(cacheOnly), null,
    "the Codex parser never calls cache-only output a complete usage report");
  assert.equal(inspectAmuxCliUsageLedgerEvent({ ...event, observation: {
    ...event.observation, observed: { ...event.observation.observed, cacheReadInputTokens: 101 },
  } }), null);
  assert.equal(inspectAmuxCliUsageLedgerEvent({ ...event, observation: {
    ...event.observation, observed: { ...event.observation.observed, reasoningOutputTokens: 31 },
  } }), null);
});

test("unknown fields, unsafe identifiers and inconsistent totals fail closed", () => {
  const bad = [
    { ...claude(), prompt: "sensitive idea" },
    { ...claude(), invocationId: "not-a-uuid" },
    { ...claude(), selectedModelId: "../model" },
    { ...claude(), startedAt: "2026-10-02T00:02:00.000Z" },
    { ...claude(), observation: { ...claude().observation, rawResult: "secret" } },
    { ...claude(), observation: { ...claude().observation, observed: counts(24, 10, 5, 2) } },
    { ...claude(), observation: { ...claude().observation, completeness: "unknown" } },
    { ...claude(), observation: { ...claude().observation, models: [
      claude().observation.models[0], claude().observation.models[0],
    ] } },
    { ...claude(), context: { ...claude().context, secret: "must-not-store" } },
    { ...claude(), context: { kind: "idea_analysis", ideaId: "idea-1", chunkIndex: 0,
      agentId: "amux-intake", taskId: "task-1" } },
    { ...claude(), observation: { ...claude().observation,
      inputTokensIncludeCacheRead: true } },
    { ...claude(), observation: { ...claude().observation,
      observed: counts(0, 0, 0, 0), models: [{ modelId: "claude-opus-5-5", observed: counts(0, 0, 0, 0) }] } },
    { ...claude(), observation: { ...claude().observation,
      observed: counts(25, 10, 5, null),
      models: [{ modelId: "claude-opus-5-5", observed: counts(25, 10, 5, null) }] } },
    { ...claude(), observation: { ...claude().observation,
      observed: { ...counts(25, 10, 5, 2), reasoningOutputTokens: 1 },
      models: [{ modelId: "claude-opus-5-5", observed: { ...counts(25, 10, 5, 2), reasoningOutputTokens: 1 } }] } },
  ];
  for (const value of bad) assert.equal(inspectAmuxCliUsageLedgerEvent(value), null);
});

test("partial usage remains partial and cannot be claimed as a complete invoice", () => {
  const event = claude();
  event.status = "failed";
  event.observation = { ...event.observation, completeness: "reported_partial",
    completedTurns: 0, models: [] };
  const inspected = inspectAmuxCliUsageLedgerEvent(event);
  assert.ok(inspected);
  assert.equal(inspected.event.observation.completeness, "reported_partial");
  for (const status of ["failed", "timeout", "outcome_unknown"]) {
    assert.equal(inspectAmuxCliUsageLedgerEvent({ ...claude(), status }), null,
      "a complete CLI report requires a successful CLI exit");
  }
});

test("accessor objects are refused and negative zero is canonicalized", () => {
  const withGetter = claude();
  Object.defineProperty(withGetter, "status", { enumerable: true, get: () => "succeeded" });
  assert.equal(inspectAmuxCliUsageLedgerEvent(withGetter), null);
  let reads = 0;
  const changingId = new Proxy(claude(), { get: (target, key) =>
    key === "invocationId" && ++reads >= 3 ? "PROMPT_TEXT_MUST_NOT_ENTER_RECEIPT" : target[key] });
  assert.equal(inspectAmuxCliUsageLedgerEvent(changingId), null);
  const changingCount = claude();
  changingCount.observation.observed = new Proxy(changingCount.observation.observed, {
    get: (target, key) => key === "inputTokens" ? -1 : target[key],
  });
  assert.equal(inspectAmuxCliUsageLedgerEvent(changingCount), null);
  const forgedIterator = claude();
  let modelReads = 0;
  const forgedModel = new Proxy(structuredClone(forgedIterator.observation.models[0]), {
    get: (target, key) => key === "modelId" && ++modelReads >= 4
      ? "PROMPT_TEXT ../../leak" : target[key],
  });
  const arrayPrototype = Object.create(Array.prototype);
  arrayPrototype[Symbol.iterator] = function* () { yield forgedModel; };
  Object.setPrototypeOf(forgedIterator.observation.models, arrayPrototype);
  assert.equal(inspectAmuxCliUsageLedgerEvent(forgedIterator), null);
  const ownIterator = claude();
  ownIterator.observation.models[Symbol.iterator] = function* () { yield forgedModel; };
  assert.equal(inspectAmuxCliUsageLedgerEvent(ownIterator), null);
  const sparseWithExtra = claude();
  sparseWithExtra.observation.models.length = 2;
  sparseWithExtra.observation.models.extra = "not-a-model";
  assert.equal(inspectAmuxCliUsageLedgerEvent(sparseWithExtra), null);
  const withNegativeZero = claude();
  withNegativeZero.observation.observed.cacheReadInputTokens = -0;
  withNegativeZero.observation.models[0].observed.cacheReadInputTokens = -0;
  withNegativeZero.observation.observed.inputTokens = 20;
  withNegativeZero.observation.models[0].observed.inputTokens = 20;
  assert.equal(Object.is(inspectAmuxCliUsageLedgerEvent(withNegativeZero)?.event.observation.observed.cacheReadInputTokens, -0), false);
  const negativeZeroIndex = claude();
  negativeZeroIndex.context = { kind: "idea_analysis", ideaId: "idea-1", chunkIndex: -0,
    agentId: "amux-intake" };
  negativeZeroIndex.observation = { ...negativeZeroIndex.observation,
    completeness: "unknown", observed: null, completedTurns: -0, models: [] };
  const normalized = inspectAmuxCliUsageLedgerEvent(negativeZeroIndex);
  assert.ok(normalized);
  assert.equal(Object.is(normalized.event.context.chunkIndex, -0), false);
  assert.equal(Object.is(normalized.event.observation.completedTurns, -0), false);
});

test("idea analysis chunk index stays within the database integer range", () => {
  const atLimit = claude();
  atLimit.context = { kind: "idea_analysis", ideaId: "idea-1",
    chunkIndex: 2_147_483_647, agentId: "amux-intake" };
  assert.ok(inspectAmuxCliUsageLedgerEvent(atLimit));
  const beyondLimit = structuredClone(atLimit);
  beyondLimit.context.chunkIndex = 2_147_483_648;
  assert.equal(inspectAmuxCliUsageLedgerEvent(beyondLimit), null);
});
