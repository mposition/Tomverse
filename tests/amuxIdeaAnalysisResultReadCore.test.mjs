import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AMUX_V4_ANALYSIS_RESULT_READ_CODE_ENABLED,
  amuxV4AnalysisResultReadEnabled,
  matchesAmuxIdeaAnalysisCursorAudit,
  matchesAmuxIdeaAnalysisUnitCommitments,
  parseAmuxIdeaAnalysisResultView,
} from "../lib/amux/ideaAnalysisResultReadCore.ts";

test("partial cursor audit is exact while an older complete audit remains readable", () => {
  const cursor = { coverageStatus: "more", continuationKind: "output",
    remainingStartOrdinal: 0, remainingEndOrdinal: 0 };
  assert.equal(matchesAmuxIdeaAnalysisCursorAudit(cursor, cursor, true), true);
  assert.equal(matchesAmuxIdeaAnalysisCursorAudit({}, cursor, true), false);
  assert.equal(matchesAmuxIdeaAnalysisCursorAudit({}, {
    ...cursor, coverageStatus: "complete", continuationKind: null,
    remainingStartOrdinal: null, remainingEndOrdinal: null,
  }, false), true);
  assert.equal(matchesAmuxIdeaAnalysisCursorAudit({
    coverageStatus: "more",
  }, cursor, true), false);
  assert.equal(matchesAmuxIdeaAnalysisCursorAudit({
    ...cursor, remainingEndOrdinal: 1,
  }, cursor, true), false);
});

test("analysis audit commitments reject a changed, missing or reordered unit", () => {
  const units = [
    { id: "unit-01", localRef: "c0:node-0", unitKind: "node",
      bodyDigest: "a".repeat(64), bodyDigestKeyId: "key-01" },
    { id: "unit-02", localRef: "c0:card-0", unitKind: "card",
      bodyDigest: "b".repeat(64), bodyDigestKeyId: "key-01" },
  ];
  const commitments = units.map((unit) => ({ id: unit.id,
    localRef: unit.localRef, kind: unit.unitKind,
    digest: unit.bodyDigest, digestKeyId: unit.bodyDigestKeyId }));
  assert.equal(matchesAmuxIdeaAnalysisUnitCommitments(commitments, units), true);
  assert.equal(matchesAmuxIdeaAnalysisUnitCommitments(commitments, units.toReversed()), false);
  assert.equal(matchesAmuxIdeaAnalysisUnitCommitments(commitments.slice(1), units), false);
  assert.equal(matchesAmuxIdeaAnalysisUnitCommitments([
    commitments[0], { ...commitments[1], digest: "c".repeat(64) },
  ], units), false);
  for (const changed of [
    { ...units[1], localRef: null },
    { ...units[1], id: "unit-03" },
    { ...units[1], unitKind: "node" },
    { ...units[1], bodyDigestKeyId: "key-02" },
  ]) {
    assert.equal(matchesAmuxIdeaAnalysisUnitCommitments(commitments,
      [units[0], changed]), false);
  }
  const manyUnits = Array.from({ length: 41 }, (_, index) => ({
    ...units[0], id: `unit-${index + 10}`, localRef: `c0:node-${index}`,
  }));
  const manyCommitments = manyUnits.map((unit) => ({ id: unit.id,
    localRef: unit.localRef, kind: unit.unitKind,
    digest: unit.bodyDigest, digestKeyId: unit.bodyDigestKeyId }));
  assert.equal(matchesAmuxIdeaAnalysisUnitCommitments(manyCommitments, manyUnits), false);
  assert.equal(matchesAmuxIdeaAnalysisUnitCommitments([
    commitments[0], { ...commitments[1], unexpected: "text" },
  ], units), false);
});

test("the owner result read remains dark even if its environment value is enabled", () => {
  assert.equal(AMUX_V4_ANALYSIS_RESULT_READ_CODE_ENABLED, false);
  assert.equal(amuxV4AnalysisResultReadEnabled("enabled"), false);
  assert.equal(amuxV4AnalysisResultReadEnabled(undefined), false);
});

test("the Admin result renders proposal relationships only while its verified body remains", () => {
  const panel = readFileSync(new URL("../components/admin/AmuxIdeaAnalysisResultPanel.tsx",
    import.meta.url), "utf8");
  assert.match(panel, /unit\.proposal \? <AmuxIdeaProposalRelations proposal=\{unit\.proposal\} messages=\{m\} \/>/);
  assert.match(panel, /unit\.proposal\?\.kind === "card"/);
  assert.match(panel, /view\.state === "partial"/);
  assert.doesNotMatch(panel, /dangerouslySetInnerHTML/);
});

test("Admin accepts only its exact idea's bounded result shape", () => {
  const ideaId = "idea-01";
  const result = { state: "ready", ideaId, previewId: "preview-01",
    completedAt: "2026-10-03T00:00:00.000Z", outcome: "propose",
    coveredScope: null, units: [{ id: "unit-01", localRef: "c0:card-0",
      bodyDigest: "a".repeat(64), bodyDigestKeyId: "key-01",
      decisionState: "proposed", proposal: { kind: "card", localId: "c0:card-0",
        cardType: "story", storyKind: "general",
        title: "Review a proposed card", problem: "The owner needs a review.",
        featureRef: "c0:node-1", parentStoryRef: null,
        dependencyRefs: [], duplicateCandidateRefs: [], sourceRefIds: ["source-1"],
        taskRole: null, executionGrade: null, executionBrief: null,
        scopeIn: ["Show the proposal"], scopeOut: [],
        completionCriteria: ["Owner can inspect the unit"] } }] };
  assert.deepEqual(parseAmuxIdeaAnalysisResultView(200, result, ideaId), result);
  const partial = { ...result, state: "partial", remainingScope: "More tasks remain." };
  assert.deepEqual(parseAmuxIdeaAnalysisResultView(200, partial, ideaId), partial);
  assert.equal(parseAmuxIdeaAnalysisResultView(200, {
    ...partial, outcome: "reject",
  }, ideaId), null);
  assert.equal(parseAmuxIdeaAnalysisResultView(200, {
    ...partial, remainingScope: "",
  }, ideaId), null);
  assert.equal(parseAmuxIdeaAnalysisResultView(200, {
    ...partial, unexpected: true,
  }, ideaId), null);
  assert.deepEqual(parseAmuxIdeaAnalysisResultView(200, { state: "pending" }, ideaId),
    { state: "pending" });
  assert.equal(parseAmuxIdeaAnalysisResultView(503, result, ideaId), null);
  assert.equal(parseAmuxIdeaAnalysisResultView(200, result, "other-idea"), null);
  assert.equal(parseAmuxIdeaAnalysisResultView(200, {
    ...result, units: [{ ...result.units[0], proposal: null }],
  }, ideaId)?.state, "ready", "one purged unit is explicitly represented");
  assert.equal(parseAmuxIdeaAnalysisResultView(200, {
    ...result, units: [{ ...result.units[0], proposal: { ...result.units[0].proposal,
      localId: "other" } }],
  }, ideaId), null);
  assert.equal(parseAmuxIdeaAnalysisResultView(200, {
    ...result, units: [{ ...result.units[0], bodyDigest: "invalid" }],
  }, ideaId), null);
  for (const malformed of [
    { cardType: "initiative" }, { storyKind: "proposal" },
    { dependencyRefs: undefined }, { sourceRefIds: [] },
    { parentStoryRef: 123 }, { featureRef: null },
    { featureRef: "contains,comma" }, { sourceRefIds: ["\u202eunsafe"] },
    { sourceRefIds: ["source-1", "source-1"] },
    { scopeIn: [] }, { completionCriteria: [] },
    { dependencyRefs: ["c0:card-0"] }, { dependencyRefs: ["other-task"] },
    { parentStoryRef: "other-story" },
    { duplicateCandidateRefs: ["c0:card-0"] },
    { unexpected: "extra field" },
  ]) {
    assert.equal(parseAmuxIdeaAnalysisResultView(200, { ...result,
      units: [{ ...result.units[0], proposal: { ...result.units[0].proposal,
        ...malformed } }],
    }, ideaId), null);
  }
  const task = { ...result.units[0].proposal, cardType: "task", storyKind: null,
    taskRole: "design", executionGrade: "routine", executionBrief: "Design one unit" };
  assert.equal(parseAmuxIdeaAnalysisResultView(200, { ...result,
    units: [{ ...result.units[0], proposal: task }],
  }, ideaId)?.state, "ready");
  for (const malformed of [
    { taskRole: "unapproved_role" }, { executionGrade: "unapproved_grade" },
    { executionBrief: null }, { storyKind: "bug" }, { taskRole: null },
    { dependencyRefs: ["c0:card-0"] },
  ]) {
    assert.equal(parseAmuxIdeaAnalysisResultView(200, { ...result,
      units: [{ ...result.units[0], proposal: { ...task, ...malformed } }],
    }, ideaId), null);
  }
  const node = { kind: "node", localId: "c0:node-0", level: "initiative",
    parentRef: null, title: "Organize work", description: "One top-level goal",
    sourceRefIds: ["source-1"] };
  const evidence = { kind: "evidence", localId: "c0:evidence-0",
    evidenceType: "source_finding", summary: "Observed in source",
    cardRef: "c0:card-0", sourceRefIds: ["source-1"] };
  for (const [localRef, proposal, malformed] of [
    [node.localId, node, { level: "project" }],
    [node.localId, node, { sourceRefIds: [] }],
    [node.localId, node, { parentRef: "c0:node-1" }],
    [node.localId, node, { parentRef: "contains,comma" }],
    [node.localId, { ...node, level: "epic", parentRef: "c0:node-1" },
      { parentRef: null }],
    [node.localId, { ...node, level: "epic", parentRef: "c0:node-1" },
      { parentRef: node.localId }],
    [evidence.localId, evidence, { evidenceType: "freeform" }],
    [evidence.localId, evidence, { cardRef: null }],
    [evidence.localId, evidence, { cardRef: "\u202eunsafe" }],
    [evidence.localId, evidence, { sourceRefIds: [] }],
  ]) {
    const unit = { ...result.units[0], localRef, proposal };
    assert.equal(parseAmuxIdeaAnalysisResultView(200, { ...result,
      units: [unit],
    }, ideaId)?.state, "ready");
    assert.equal(parseAmuxIdeaAnalysisResultView(200, { ...result,
      units: [{ ...unit, proposal: { ...proposal, ...malformed } }],
    }, ideaId), null);
  }
});
