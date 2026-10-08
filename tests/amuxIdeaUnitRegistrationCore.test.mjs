import assert from "node:assert/strict";
import test from "node:test";

import { amuxCanonicalJson } from "../lib/amux/boardImportCore.ts";
import { amuxContentDigest } from "../lib/amux/ideaCrypto.ts";
import { deriveAmuxIdeaUnitConfirmation } from
  "../lib/amux/ideaUnitConfirmationCore.ts";
import { inspectAmuxV4CardRegistration } from
  "../lib/amux/ideaUnitRegistrationCore.ts";
import { calculateV4TaskCostCeiling } from
  "../lib/amux/v4TaskCostCeilingCore.ts";

const key = { digestKeyId: "key_v1", digestKey: Buffer.alloc(32, 7) };
const keyed = (letter) => ({ digest: letter.repeat(64), keyId: key.digestKeyId });
const proposal = () => ({ kind: "card", localId: "c0:card-0", cardType: "story",
  storyKind: "general", title: "One checked Story", problem: "Need one result",
  scopeIn: ["one result"], scopeOut: ["execution"],
  completionCriteria: ["one verification"], featureRef: "c0:node-2",
  parentStoryRef: null, dependencyRefs: [], duplicateCandidateRefs: [],
  taskRole: null, executionGrade: null, executionBrief: null, sourceRefIds: [] });
const hierarchy = [
  { id: "initiative_001", level: "initiative", parentId: null,
    revision: 1, content: keyed("a"), state: "active",
    approvedDecisionId: "decision_initiative_01" },
  { id: "epic_00000001", level: "epic", parentId: "initiative_001",
    revision: 1, content: keyed("b"), state: "active",
    approvedDecisionId: "decision_epic_001" },
  { id: "feature_00001", level: "feature", parentId: "epic_00000001",
    revision: 1, content: keyed("c"), state: "active",
    approvedDecisionId: "decision_feature_01" },
];

function fixture() {
  const candidate = proposal();
  const body = amuxContentDigest(Buffer.from(amuxCanonicalJson(candidate), "utf8"),
    "analysis_draft", "draft_0000001", key);
  const keyedBody = { digest: body.digest, keyId: body.digestKeyId };
  const scan = { scanVersion: "dedupe_v1",
    checkedAtIso: "2026-10-01T01:00:00.000Z", query: keyed("d"),
    result: keyed("e"), complete: true, candidates: [] };
  const snapshot = {
    schemaVersion: 1, policyVersion: "amux-intake-v11",
    canonicalizerVersion: "amux-canonical-v1", scannerVersion: "scanner-v1",
    ideaId: "idea_00000001", decisionId: "decision_00001",
    prepareRequestId: "00000000-0000-4000-8000-000000000001",
    actorUserId: "owner_0000001", ownerSession: keyed("1"),
    draftUnitId: "draft_0000001", localRef: candidate.localId,
    unitVersion: 1, unitKind: "card", unitBody: keyedBody,
    draftShape: { kind: "card", cardType: "story", storyKind: "general" },
    action: "register_card", source: {
      previewId: "preview_00001", payload: keyed("3"),
      scopeApprovalId: null, scope: null }, hierarchy,
    nodeProposal: null, target: null,
    card: { cardType: "story", storyKind: "general", normalizedBody: keyedBody,
      featureNodeId: "feature_00001", parentStory: null,
      dependencies: [], evidence: [], task: null },
    duplicates: scan, decisionReason: null,
  };
  const confirmation = deriveAmuxIdeaUnitConfirmation(snapshot, key, scan, null);
  assert.equal(confirmation.ok, true);
  const prepared = { id: snapshot.decisionId, ideaId: snapshot.ideaId,
    draftUnitId: snapshot.draftUnitId, actorUserId: snapshot.actorUserId,
    state: "prepared", preparedAt: new Date("2026-10-01T01:00:00.000Z"),
    expiresAt: new Date("2026-10-01T01:15:00.000Z"), outcomeUnknownAt: null,
    ownerSessionDigest: snapshot.ownerSession.digest,
    ownerSessionDigestKeyId: snapshot.ownerSession.keyId,
    confirmationDigest: confirmation.confirmationDigest,
    confirmationDigestKeyId: confirmation.digestKeyId,
    unitDigest: body.digest, unitDigestKeyId: body.digestKeyId,
    sourcePreviewId: snapshot.source.previewId,
    sourcePreviewDigest: snapshot.source.payload.digest,
    sourcePreviewDigestKeyId: snapshot.source.payload.keyId };
  const context = { decisionId: prepared.id, ideaId: prepared.ideaId,
    draftUnitId: prepared.draftUnitId, actorUserId: prepared.actorUserId,
    recentOwnerStepUp: true, ownerSessionDigest: prepared.ownerSessionDigest,
    ownerSessionDigestKeyId: prepared.ownerSessionDigestKeyId,
    databaseNow: new Date("2026-10-01T01:01:00.000Z"),
    currentConfirmation: confirmation };
  return { prepared, context, confirmation, snapshot, proposal: candidate,
    digestKey: key, resolvedFeatureRef: "feature_00001" };
}

test("one checked Story becomes one inert backlog plan", () => {
  const result = inspectAmuxV4CardRegistration(fixture());
  assert.equal(result.ok, true);
  assert.deepEqual({ status: result.plan.status, owner: result.plan.owner,
    claimedAt: result.plan.claimedAt, routeDecisionCount: result.plan.routeDecisionCount },
  { status: "backlog", owner: null, claimedAt: null, routeDecisionCount: 0 });
  assert.equal(result.plan.sourceSystem, "admin-idea-v4");
  assert.equal(result.plan.sourceKey, "DRAFT_0000001");
});

test("modified proposal, source, feature or expired confirmation cannot register", () => {
  for (const mutate of [
    (input) => { input.proposal.title = "Different title"; },
    (input) => { input.prepared.sourcePreviewDigest = "f".repeat(64); },
    (input) => { input.resolvedFeatureRef = "other_feature"; },
    (input) => { input.context.databaseNow = input.prepared.expiresAt; },
    (input) => { input.context.recentOwnerStepUp = false; },
  ]) {
    const input = fixture();
    mutate(input);
    assert.equal(inspectAmuxV4CardRegistration(input).ok, false);
  }
});

test("Task brief and approved cost must match the stored proposal and current price", () => {
  const input = fixture();
  input.proposal.cardType = "task";
  input.proposal.storyKind = null;
  input.proposal.taskRole = "implementation";
  input.proposal.executionGrade = "standard";
  input.proposal.executionBrief = "Implement and test one bounded change";
  input.snapshot.draftShape = { kind: "card", cardType: "task", storyKind: null };
  input.snapshot.card.cardType = "task";
  input.snapshot.card.storyKind = null;
  const cost = calculateV4TaskCostCeiling({
    role: "implementation", grade: "standard", catalogVersion: "catalog-v1",
    catalogDigest: "e".repeat(64), pricingVersion: "price-v1",
    gradeRulesVersion: "rules-v1", asOfIso: "2026-10-01T01:00:00.000Z",
    caps: { uncachedInputTokens: 1000, outputTokens: 1000,
      cacheReadTokens: 0, cacheWriteTokens: 0, maxAttempts: 2 },
    routes: [{ routeId: "codex/implementation", workerName: "worker-codex",
      provider: "openai", modelId: "openai/frontier-model",
      routePolicyDigest: "f".repeat(64), enabled: true,
      roles: ["implementation"], grades: ["standard"],
      pricingSource: "verified-record", pricingVerifiedAt: "2026-10-01T00:00:00.000Z",
      uncachedInputMicroUsdPerMillion: 1_000_000,
      outputMicroUsdPerMillion: 2_000_000,
      cacheReadMicroUsdPerMillion: 0, cacheWriteMicroUsdPerMillion: 0,
      toolCostCapMicroUsdPerAttempt: 0 }],
  });
  assert.equal(cost.ok, true);
  const body = amuxContentDigest(Buffer.from(amuxCanonicalJson(input.proposal), "utf8"),
    "analysis_draft", input.prepared.draftUnitId, key);
  const brief = amuxContentDigest(Buffer.from(input.proposal.executionBrief, "utf8"),
    "analysis_draft", input.prepared.draftUnitId, key);
  input.prepared.unitDigest = body.digest;
  input.snapshot.unitBody.digest = body.digest;
  input.snapshot.card.normalizedBody.digest = body.digest;
  input.snapshot.card.task = { role: "implementation", grade: "standard",
    brief: { digest: brief.digest, keyId: brief.digestKeyId },
    costReceipt: cost.receipt };
  input.snapshot.duplicates = { ...input.snapshot.duplicates };
  input.confirmation = deriveAmuxIdeaUnitConfirmation(input.snapshot,
    key, input.snapshot.duplicates, cost);
  assert.equal(input.confirmation.ok, true);
  input.context.currentConfirmation = input.confirmation;
  input.prepared.confirmationDigest = input.confirmation.confirmationDigest;
  const registered = inspectAmuxV4CardRegistration(input);
  assert.equal(registered.ok, true);
  assert.equal(registered.plan.maximumCostMicroUsd, cost.receipt.ceilingMicroUsd);

  const altered = { ...structuredClone(input), digestKey: key };
  altered.snapshot.card.task.brief.digest = "0".repeat(64);
  assert.equal(inspectAmuxV4CardRegistration(altered).ok, false);
  const stalePrice = { ...structuredClone(input), digestKey: key };
  stalePrice.confirmation = deriveAmuxIdeaUnitConfirmation(stalePrice.snapshot,
    key, stalePrice.snapshot.duplicates, null);
  assert.equal(inspectAmuxV4CardRegistration(stalePrice).ok, false);
});
