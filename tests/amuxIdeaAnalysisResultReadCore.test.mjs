import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_V4_ANALYSIS_RESULT_READ_CODE_ENABLED,
  amuxV4AnalysisResultReadEnabled,
  matchesAmuxIdeaAnalysisUnitCommitments,
  parseAmuxIdeaAnalysisResultView,
} from "../lib/amux/ideaAnalysisResultReadCore.ts";

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

test("the owner result read requires its exact environment switch", () => {
  assert.equal(AMUX_V4_ANALYSIS_RESULT_READ_CODE_ENABLED, true);
  assert.equal(amuxV4AnalysisResultReadEnabled("enabled"), true);
  assert.equal(amuxV4AnalysisResultReadEnabled("disabled"), false);
  assert.equal(amuxV4AnalysisResultReadEnabled(undefined), false);
});

test("Admin accepts only its exact idea's bounded result shape", () => {
  const ideaId = "idea-01";
  const result = { state: "ready", ideaId, previewId: "preview-01",
    completedAt: "2026-10-03T00:00:00.000Z", outcome: "propose",
    coveredScope: null, units: [{ id: "unit-01", localRef: "c0:card-0",
      bodyDigest: "a".repeat(64), bodyDigestKeyId: "key-01",
      decisionState: "proposed", proposal: { kind: "card", localId: "c0:card-0",
        title: "Review a proposed card", problem: "The owner needs a review.",
        scopeIn: ["Show the proposal"], scopeOut: [],
        completionCriteria: ["Owner can inspect the unit"] } }] };
  assert.deepEqual(parseAmuxIdeaAnalysisResultView(200, result, ideaId), result);
  const partial = { ...result, state: "partial", remainingScope: "One more Task",
    nextChunkIndex: 1 };
  assert.deepEqual(parseAmuxIdeaAnalysisResultView(200, partial, ideaId), partial);
  assert.equal(parseAmuxIdeaAnalysisResultView(200, {
    ...partial, remainingScope: "",
  }, ideaId), null);
  assert.equal(parseAmuxIdeaAnalysisResultView(200, {
    ...partial, nextChunkIndex: -1,
  }, ideaId), null);
  assert.deepEqual(parseAmuxIdeaAnalysisResultView(200, { state: "pending" }, ideaId),
    { state: "pending" });
  assert.deepEqual(parseAmuxIdeaAnalysisResultView(200,
    { state: "needs_new_preview" }, ideaId), { state: "needs_new_preview" });
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
});
