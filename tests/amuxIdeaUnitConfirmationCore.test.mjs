import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  deriveAmuxIdeaUnitConfirmation,
  sameAmuxIdeaUnitConfirmation,
} from "../lib/amux/ideaUnitConfirmationCore.ts";
import { calculateV4TaskCostCeiling } from "../lib/amux/v4TaskCostCeilingCore.ts";

const hash = (letter) => letter.repeat(64);
const keyed = (letter) => ({ digest: hash(letter), keyId: "key_v1" });
const key = { digestKeyId: "confirmation_v1", digestKey: Buffer.alloc(32, 7) };
const clone = (value) => structuredClone(value);

const node = (level, id, parentId, letter) => ({
  id, level, parentId, revision: 1, content: keyed(letter),
  state: "active", approvedDecisionId: `decision_${level}_01`,
});
const hierarchy = [
  node("initiative", "initiative_001", null, "a"),
  node("epic", "epic_00000001", "initiative_001", "b"),
  node("feature", "feature_00001", "epic_00000001", "c"),
];
const cardRef = (id, cardType = "task") => ({
  id, cardType, featureNodeId: "feature_00001", revision: 2, content: keyed("d"),
  sourceSystem: "admin-idea-v4", status: "backlog",
});

const costResult = (asOfIso = "2026-10-01T01:00:00.000Z") => {
  const result = calculateV4TaskCostCeiling({
    role: "implementation", grade: "standard",
    catalogVersion: "catalog_v1", catalogDigest: hash("e"),
    pricingVersion: "prices_v1", gradeRulesVersion: "grades_v1",
    asOfIso,
    caps: {
      uncachedInputTokens: 1_000, outputTokens: 1_000,
      cacheReadTokens: 0, cacheWriteTokens: 0, maxAttempts: 2,
    },
    routes: [{
      routeId: "codex/implementation", workerName: "worker-codex",
      provider: "openai", modelId: "openai/frontier-model",
      routePolicyDigest: hash("f"), enabled: true,
      roles: ["implementation"], grades: ["standard"],
      pricingSource: "verified-record",
      pricingVerifiedAt: "2026-10-01T00:00:00.000Z",
      uncachedInputMicroUsdPerMillion: 1_000_000,
      outputMicroUsdPerMillion: 2_000_000,
      cacheReadMicroUsdPerMillion: 0,
      cacheWriteMicroUsdPerMillion: 0,
      toolCostCapMicroUsdPerAttempt: 0,
    }],
  });
  assert.equal(result.ok, true);
  return result;
};

const confirm = (
  value,
  currentCost = value.card?.task ? costResult() : null,
  currentScan = clone(value.duplicates),
) => deriveAmuxIdeaUnitConfirmation(value, key, currentScan, currentCost);

const story = () => ({
  schemaVersion: 1, policyVersion: "amux-intake-v11",
  canonicalizerVersion: "amux-canonical-v1", scannerVersion: "scanner-v1",
  ideaId: "idea_00000001", decisionId: "decision_00001",
  prepareRequestId: "00000000-0000-4000-8000-000000000001",
  actorUserId: "owner_0000001", ownerSession: keyed("1"),
  draftUnitId: "draft_0000001", localRef: "c0:card-0", unitVersion: 1,
  unitKind: "card", unitBody: keyed("2"),
  draftShape: { kind: "card", cardType: "story", storyKind: "general" },
  action: "register_card",
  source: {
    previewId: "preview_00001", payload: keyed("3"),
    scopeApprovalId: null, scope: null,
  },
  hierarchy: clone(hierarchy), nodeProposal: null, target: null,
  duplicates: {
    scanVersion: "dedupe_v1", checkedAtIso: "2026-10-01T01:00:00.000Z",
    query: keyed("a"), result: keyed("b"), complete: true, candidates: [],
  },
  card: {
    cardType: "story", storyKind: "general", normalizedBody: keyed("4"),
    featureNodeId: "feature_00001", parentStory: null,
    dependencies: [], evidence: [], task: null,
  },
  decisionReason: null,
});

const task = () => {
  const value = story();
  value.card.cardType = "task";
  value.card.storyKind = null;
  value.draftShape = { kind: "card", cardType: "task", storyKind: null };
  value.card.parentStory = cardRef("story_0000001", "story");
  value.card.dependencies = [cardRef("task_00000002"), cardRef("task_00000001")];
  value.card.evidence = [
    { id: "evidence_0002", content: keyed("5") },
    { id: "evidence_0001", content: keyed("6") },
  ];
  value.card.task = {
    role: "implementation", grade: "standard", brief: keyed("7"),
    costReceipt: costResult().receipt,
  };
  return value;
};

test("owner confirmation binds one card without retaining raw input", () => {
  const result = confirm(story());
  assert.equal(result.ok, true);
  assert.match(result.confirmationDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.digestKeyId, "confirmation_v1");
  assert.ok(result.bytes < 32_768);
  assert.equal(sameAmuxIdeaUnitConfirmation(result.confirmationDigest, result.confirmationDigest), true);
  assert.equal(sameAmuxIdeaUnitConfirmation(result.confirmationDigest, hash("0")), false);
});

test("Task cost receipt, parent and dependency set are bound", () => {
  const value = task();
  const first = confirm(value);
  assert.equal(first.ok, true);
  const reordered = clone(value);
  reordered.card.dependencies.reverse();
  reordered.card.evidence.reverse();
  assert.equal(confirm(reordered).confirmationDigest,
    first.confirmationDigest);

  for (const mutate of [
    (v) => { v.card.task.brief = keyed("8"); },
    (v) => { v.card.task.costReceipt.ceilingMicroUsd = "999999"; },
    (v) => { v.card.parentStory.revision += 1; },
    (v) => { v.card.dependencies.pop(); },
    (v) => { v.hierarchy[2].content = keyed("9"); },
    (v) => { v.source.payload = keyed("a"); },
    (v) => { v.ownerSession = keyed("b"); },
  ]) {
    const changed = clone(value);
    mutate(changed);
    const result = confirm(changed);
    assert.ok(!result.ok || result.confirmationDigest !== first.confirmationDigest);
  }
});

test("duplicate scan is mandatory, complete and bound to the owner's choice", () => {
  const value = story();
  const original = confirm(value);
  assert.equal(original.ok, true);
  const unscanned = clone(value);
  unscanned.duplicates = null;
  assert.deepEqual(confirm(unscanned), { ok: false, code: "semantic_conflict" });
  const changed = clone(value);
  changed.duplicates.candidates = [{
    id: "story_0000001", kind: "card", revision: 1, content: keyed("c"),
  }];
  changed.duplicates.result = keyed("d");
  changed.decisionReason = keyed("e");
  const reviewed = confirm(changed);
  assert.equal(reviewed.ok, true);
  assert.notEqual(reviewed.confirmationDigest, original.confirmationDigest);
  assert.deepEqual(confirm(changed, null, value.duplicates),
    { ok: false, code: "semantic_conflict" });
  changed.duplicates.complete = false;
  assert.deepEqual(confirm(changed), { ok: false, code: "schema_rejected" });
});

test("a self-consistent but unverified cost receipt cannot replace server recalculation", () => {
  const value = task();
  assert.equal(confirm(value).ok, true);
  const fake = clone(value);
  fake.card.task.costReceipt.routes[0].perAttemptMicroUsd = "1";
  fake.card.task.costReceipt.ceilingMicroUsd = "2";
  const { receiptDigest, ...core } = fake.card.task.costReceipt;
  assert.match(receiptDigest, /^[a-f0-9]{64}$/);
  fake.card.task.costReceipt.receiptDigest = createHash("sha256")
    .update("amux-v4-task-cost-receipt-v1\n")
    .update(JSON.stringify(core))
    .digest("hex");
  const original = value.card.task.costReceipt;
  const { receiptDigest: originalDigest, ...originalCore } = original;
  assert.equal(createHash("sha256")
    .update("amux-v4-task-cost-receipt-v1\n")
    .update(JSON.stringify(originalCore)).digest("hex"), originalDigest);
  assert.deepEqual(confirm(fake), { ok: false, code: "semantic_conflict" });
  const inflated = clone(value);
  inflated.card.task.costReceipt.ceilingMicroUsd = "999999";
  assert.deepEqual(confirm(inflated), { ok: false, code: "semantic_conflict" });
  const swappedRoute = clone(value);
  swappedRoute.card.task.costReceipt.routes[0].modelId = "openai/other-frontier";
  assert.deepEqual(confirm(swappedRoute), { ok: false, code: "semantic_conflict" });
  assert.deepEqual(confirm(value, null), { ok: false, code: "semantic_conflict" });
  const malformedClock = costResult();
  malformedClock.receipt.calculatedAtIso = undefined;
  assert.deepEqual(confirm(value, malformedClock),
    { ok: false, code: "semantic_conflict" });
});

test("a fresh scan and price recomputation may advance timestamps without changing the approved facts", () => {
  const value = task();
  const atPrepare = confirm(value);
  const currentScan = clone(value.duplicates);
  currentScan.checkedAtIso = "2026-10-01T01:05:00.000Z";
  const atConsume = confirm(value, costResult("2026-10-01T01:05:00.000Z"), currentScan);
  assert.equal(atPrepare.ok, true);
  assert.equal(atConsume.ok, true);
  assert.equal(atConsume.confirmationDigest, atPrepare.confirmationDigest);
  currentScan.checkedAtIso = "2026-10-01T00:55:00.000Z";
  assert.deepEqual(confirm(value, costResult(), currentScan),
    { ok: false, code: "semantic_conflict" });
  currentScan.checkedAtIso = "2026-10-01T01:05:00.000Z";
  assert.deepEqual(confirm(value, costResult("2026-10-01T00:55:00.000Z"), currentScan),
    { ok: false, code: "semantic_conflict" });
});

test("node creation and existing node selection are separate owner actions", () => {
  const create = story();
  create.unitKind = "node";
  create.localRef = "c0:node-0";
  create.draftShape = { kind: "node", level: "feature" };
  create.card = null;
  create.hierarchy = hierarchy.slice(0, 2);
  create.action = "create_node";
  create.nodeProposal = { id: "new_feature_01", level: "feature", parentId: "epic_00000001" };
  assert.equal(confirm(create).ok, true);

  const select = clone(create);
  select.action = "select_existing_node";
  select.nodeProposal = null;
  select.target = { kind: "node", ...hierarchy[2] };
  const selected = confirm(select);
  assert.equal(selected.ok, true);
  assert.notEqual(selected.confirmationDigest,
    confirm(create).confirmationDigest);
  select.target.parentId = "initiative_001";
  assert.deepEqual(confirm(select),
    { ok: false, code: "semantic_conflict" });
  select.target.parentId = "epic_00000001";
  select.draftShape.level = "epic";
  assert.deepEqual(confirm(select),
    { ok: false, code: "semantic_conflict" });
});

test("reject needs a reason but never needs a priced Task", () => {
  const value = story();
  value.action = "reject_unit";
  value.card = null;
  value.hierarchy = [];
  value.duplicates = null;
  value.decisionReason = keyed("d");
  assert.equal(confirm(value).ok, true);
  value.decisionReason = null;
  assert.deepEqual(confirm(value),
    { ok: false, code: "semantic_conflict" });
});

test("existing-card links bind a typed v4 target and review reason without creating a card", () => {
  const value = story();
  value.action = "link_existing_card";
  value.card = null;
  value.target = {
    kind: "card", id: "story_0000001", cardType: "story",
    storyKind: "general", status: "backlog",
    featureNodeId: "feature_00001", sourceSystem: "admin-idea-v4",
    revision: 3, content: keyed("e"),
  };
  value.decisionReason = keyed("f");
  assert.equal(confirm(value).ok, true);
  value.target.featureNodeId = "other_feature_01";
  assert.deepEqual(confirm(value),
    { ok: false, code: "semantic_conflict" });
  value.target.featureNodeId = "feature_00001";
  value.target.cardType = "task";
  value.target.storyKind = null;
  assert.deepEqual(confirm(value),
    { ok: false, code: "semantic_conflict" });
  value.target.cardType = "story";
  assert.deepEqual(confirm(value),
    { ok: false, code: "semantic_conflict" });
});

test("parent and dependency references must be typed v4 cards in usable states", () => {
  const legacy = task();
  legacy.card.dependencies[0].sourceSystem = "legacy";
  assert.deepEqual(confirm(legacy), { ok: false, code: "schema_rejected" });
  const cancelled = task();
  cancelled.card.dependencies[0].status = "cancelled";
  assert.deepEqual(confirm(cancelled), { ok: false, code: "semantic_conflict" });
  const wrongType = task();
  wrongType.card.dependencies[0].cardType = "story";
  assert.deepEqual(confirm(wrongType), { ok: false, code: "semantic_conflict" });
});

test("unknown fields, mismatched kind, broken scope and forged receipt fail closed", () => {
  const raw = story();
  raw.rawPrompt = "do not persist me";
  assert.deepEqual(confirm(raw),
    { ok: false, code: "schema_rejected" });
  const wrongRef = story();
  wrongRef.localRef = "c0:node-0";
  assert.deepEqual(confirm(wrongRef),
    { ok: false, code: "semantic_conflict" });
  const brokenScope = story();
  brokenScope.source.scopeApprovalId = "scope_000001";
  assert.deepEqual(confirm(brokenScope),
    { ok: false, code: "semantic_conflict" });
  const forged = task();
  forged.card.task.costReceipt.receiptDigest = hash("0");
  assert.deepEqual(confirm(forged),
    { ok: false, code: "semantic_conflict" });
  const incoherentStory = story();
  incoherentStory.draftShape.storyKind = null;
  incoherentStory.card.storyKind = null;
  assert.deepEqual(confirm(incoherentStory),
    { ok: false, code: "semantic_conflict" });
  const missingCost = task();
  assert.deepEqual(deriveAmuxIdeaUnitConfirmation(missingCost, key,
    missingCost.duplicates, undefined),
    { ok: false, code: "semantic_conflict" });
  const outOfRange = task();
  outOfRange.card.task.costReceipt.ceilingMicroUsd = "9223372036854775808";
  assert.deepEqual(confirm(outOfRange),
    { ok: false, code: "schema_rejected" });
  const unknownAction = story();
  unknownAction.action = "merge_everything";
  assert.deepEqual(confirm(unknownAction),
    { ok: false, code: "schema_rejected" });
  const oversized = story();
  oversized.scannerVersion = "x".repeat(40_000);
  assert.deepEqual(confirm(oversized), { ok: false, code: "too_large" });
  assert.deepEqual(deriveAmuxIdeaUnitConfirmation(story(),
    { digestKeyId: "bad", digestKey: Buffer.alloc(31) }, story().duplicates, null),
  { ok: false, code: "key_invalid" });
});
