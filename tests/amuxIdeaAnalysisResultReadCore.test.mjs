import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_V4_ANALYSIS_RESULT_READ_CODE_ENABLED,
  amuxV4AnalysisResultReadEnabled,
  parseAmuxIdeaAnalysisResultView,
} from "../lib/amux/ideaAnalysisResultReadCore.ts";

test("the owner result read remains dark even if its environment value is enabled", () => {
  assert.equal(AMUX_V4_ANALYSIS_RESULT_READ_CODE_ENABLED, false);
  assert.equal(amuxV4AnalysisResultReadEnabled("enabled"), false);
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
});
