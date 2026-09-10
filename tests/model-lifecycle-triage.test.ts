import assert from "node:assert/strict";
import test from "node:test";
import {
  assessModelLifecycleItem,
  candidateFamilyIdentity,
  candidateRepresentativeRank,
  isSpecializedNonChatModel,
  shouldQueueModelCandidate,
} from "../lib/modelLifecycleTriage.ts";

test("dated snapshots and moving aliases share one semantic family", () => {
  for (const apiModel of [
    "gpt-4o-2024-08-06",
    "gpt-4o-0806",
    "openai/gpt-4o-latest",
  ]) {
    assert.equal(candidateFamilyIdentity(apiModel), "gpt-4o");
  }
  assert.equal(candidateFamilyIdentity("gpt-5.5"), "gpt-5.5");
  assert.equal(candidateFamilyIdentity("gpt-5.6"), "gpt-5.6");
});

test("a stable id wins over aliases and snapshots as family representative", () => {
  assert.ok(
    candidateRepresentativeRank("gpt-4o") <
      candidateRepresentativeRank("gpt-4o-2024-08-06")
  );
  assert.ok(
    candidateRepresentativeRank("gpt-4o-2024-08-06") <
      candidateRepresentativeRank("gpt-4o-latest")
  );
});

test("non-chat OpenAI product ids are observed but do not enter review", () => {
  for (const apiModel of [
    "gpt-image-1",
    "gpt-4o-audio-preview",
    "gpt-realtime",
    "gpt-5-search-api",
  ]) {
    assert.equal(isSpecializedNonChatModel(apiModel), true, apiModel);
    assert.equal(shouldQueueModelCandidate(apiModel), false, apiModel);
  }
  assert.equal(shouldQueueModelCandidate("gpt-5.6-sol"), true);
});

test("a current unserved general chat model is recommended with Korean rationale", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "gpt-5.6-sol",
    providers: ["openai"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
  });
  assert.equal(assessment.priority, "recommended");
  assert.equal(assessment.kind, "general_chat");
  assert.match(assessment.analysisKo, /최신 모델 API/);
  assert.match(assessment.analysisKo, /편입 가치/);
});

test("stale, lifecycle-marked and already-served additions are no-action suggestions", () => {
  const common = {
    action: "add",
    apiModel: "gpt-4",
    providers: ["openai"],
  };
  assert.equal(
    assessModelLifecycleItem({
      ...common,
      availability: "stale",
      lifecycle: null,
      servedByTomverse: false,
    }).priority,
    "no_action"
  );
  assert.equal(
    assessModelLifecycleItem({
      ...common,
      availability: "current",
      lifecycle: "shutdown_scheduled",
      servedByTomverse: false,
    }).priority,
    "no_action"
  );
  assert.equal(
    assessModelLifecycleItem({
      ...common,
      availability: "current",
      lifecycle: null,
      servedByTomverse: true,
    }).priority,
    "no_action"
  );
});

test("failed provider evidence cannot be mistaken for retirement", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "gpt-5.7",
    providers: ["openai"],
    availability: "unknown",
    lifecycle: null,
    servedByTomverse: false,
  });
  assert.equal(assessment.priority, "needs_evidence");
  assert.match(assessment.analysisKo, /확인하기 전/);
});

test("retirement work stays urgent even though the model is stale", () => {
  const assessment = assessModelLifecycleItem({
    action: "retire",
    apiModel: "legacy-chat-model",
    providers: ["provider"],
    availability: "stale",
    lifecycle: null,
    servedByTomverse: true,
  });
  assert.equal(assessment.priority, "recommended");
  assert.equal(assessment.kind, "retirement");
  assert.match(assessment.analysisKo, /사용자 영향/);
});
