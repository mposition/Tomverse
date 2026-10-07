import assert from "node:assert/strict";
import test from "node:test";

import { amuxCanonicalJson } from "../lib/amux/boardImportCore.ts";
import { amuxContentDigest } from "../lib/amux/ideaCrypto.ts";
import { deriveAmuxIdeaUnitConfirmation } from
  "../lib/amux/ideaUnitConfirmationCore.ts";
import { assembleAmuxV4TaskConfirmation } from
  "../lib/amux/ideaTaskConfirmationSnapshotCore.ts";
import { calculateV4TaskCostCeiling } from
  "../lib/amux/v4TaskCostCeilingCore.ts";

const key = { digestKeyId: "key_v1", digestKey: Buffer.alloc(32, 7) };
const keyed = (digit) => ({ digest: digit.repeat(64), keyId: key.digestKeyId });
const hierarchy = [
  { id: "initiative_001", level: "initiative", parentId: null, revision: 0,
    content: keyed("a"), state: "active", approvedDecisionId: "decision_initiative_01" },
  { id: "epic_00000001", level: "epic", parentId: "initiative_001", revision: 0,
    content: keyed("b"), state: "active", approvedDecisionId: "decision_epic_0001" },
  { id: "feature_00001", level: "feature", parentId: "epic_00000001", revision: 0,
    content: keyed("c"), state: "active", approvedDecisionId: "decision_feature_01" },
];
function fixture() {
  const proposal = { kind: "card", localId: "c0:card-1", cardType: "task",
    storyKind: null, title: "One bounded Task", problem: "Fix one result",
    scopeIn: ["one result"], scopeOut: ["deployment"],
    completionCriteria: ["one passing test"], featureRef: "c0:node-2",
    parentStoryRef: null, dependencyRefs: ["c0:card-0"],
    duplicateCandidateRefs: [], taskRole: "implementation",
    executionGrade: "standard", executionBrief: "Fix and test only this result",
    sourceRefIds: [] };
  const body = amuxContentDigest(Buffer.from(amuxCanonicalJson(proposal), "utf8"),
    "analysis_draft", "draft_0000001", key);
  const cost = calculateV4TaskCostCeiling({ role: "implementation", grade: "standard",
    catalogVersion: "catalog_v1", catalogDigest: "d".repeat(64),
    pricingVersion: "prices_v1", gradeRulesVersion: "grades_v1",
    asOfIso: "2026-10-05T01:00:00.000Z",
    caps: { uncachedInputTokens: 1000, outputTokens: 1000,
      cacheReadTokens: 0, cacheWriteTokens: 0, maxAttempts: 2 },
    routes: [{ routeId: "codex/implementation", workerName: "worker-codex",
      provider: "openai", modelId: "frontier-test", routePolicyDigest: "e".repeat(64),
      enabled: true, roles: ["implementation"], grades: ["standard"],
      pricingSource: "synthetic-test", pricingVerifiedAt: "2026-10-01T00:00:00.000Z",
      uncachedInputMicroUsdPerMillion: 1_000_000,
      outputMicroUsdPerMillion: 2_000_000,
      cacheReadMicroUsdPerMillion: 0, cacheWriteMicroUsdPerMillion: 0,
      toolCostCapMicroUsdPerAttempt: 0 }] });
  assert.equal(cost.ok, true);
  const dependency = { id: "task_00000001", cardType: "task",
    featureNodeId: "feature_00001", sourceSystem: "admin-idea-v4",
    status: "backlog", revision: 0, content: keyed("f") };
  const scan = { scanVersion: "card-title-reference-v1",
    checkedAtIso: "2026-10-05T01:00:00.000Z", query: keyed("1"),
    result: keyed("2"), complete: true, candidates: [] };
  return { ideaId: "idea_00000001", decisionId: "decision_00001",
    prepareRequestId: "00000000-0000-4000-8000-000000000001",
    actorUserId: "owner_0000001", ownerSession: keyed("3"),
    unit: { id: "draft_0000001", localRef: proposal.localId,
      bodyDigest: body.digest, bodyDigestKeyId: body.digestKeyId },
    proposal, preview: { id: "preview_00001", payloadDigest: "4".repeat(64),
      payloadDigestKeyId: key.digestKeyId, scopeApprovalId: null,
      scopeDigest: null, scopeDigestKeyId: null },
    hierarchy: structuredClone(hierarchy), sourceFeatureRef: "c0:node-2",
    parentStory: null, dependencies: [dependency], costReceipt: cost.receipt,
    duplicateScan: scan, decisionReason: null, key };
}

test("Task directly under a Feature binds approved cost and dependency without proposal body", () => {
  const input = fixture();
  const snapshot = assembleAmuxV4TaskConfirmation(input);
  assert.ok(snapshot);
  assert.equal(snapshot.card.parentStory, null);
  assert.deepEqual(snapshot.card.dependencies.map((entry) => entry.id), ["task_00000001"]);
  assert.equal(deriveAmuxIdeaUnitConfirmation(snapshot, key,
    input.duplicateScan, { ok: true, receipt: input.costReceipt }).ok, true);
  assert.equal(JSON.stringify(snapshot).includes(input.proposal.executionBrief), false);
});

test("Task cannot silently drop parent, dependency or approved price", () => {
  const input = fixture();
  input.proposal.parentStoryRef = "c0:card-2";
  assert.equal(assembleAmuxV4TaskConfirmation(input), null);
  input.proposal.parentStoryRef = null;
  input.dependencies = [];
  assert.equal(assembleAmuxV4TaskConfirmation(input), null);
  input.dependencies = [fixture().dependencies[0]];
  input.costReceipt = { ...input.costReceipt, role: "review" };
  assert.equal(assembleAmuxV4TaskConfirmation(input), null);
});
