import assert from "node:assert/strict";
import test from "node:test";
import {
  assessModelLifecycleItem,
  candidateDecisionKey,
  candidateFamilyIdentity,
  candidateRepresentativeRank,
  decisionSuppressesCandidate,
  isImageGenerationModel,
  isPrereleaseModel,
  isSearchSpecializedModel,
  isSpecializedNonChatModel,
  modelLine,
  modelProductSurface,
  newestByModelLine,
  shouldQueueModelCandidate,
  supersedingServedModel,
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

test("image generation models enter Studio review while unsupported products do not", () => {
  for (const apiModel of [
    "gpt-image-1",
    "dall-e-3",
    "gemini-3.1-flash-image",
    "grok-imagine-image-quality-20260403",
    "fal-ai/nano-banana-2",
  ]) {
    assert.equal(isImageGenerationModel(apiModel), true, apiModel);
    assert.equal(modelProductSurface(apiModel), "image_generation", apiModel);
    assert.equal(shouldQueueModelCandidate(apiModel), true, apiModel);
  }
  for (const apiModel of [
    "gpt-4o-audio-preview",
    "gpt-realtime",
    "gpt-5-search-api",
  ]) {
    assert.equal(isSpecializedNonChatModel(apiModel), true, apiModel);
    assert.equal(shouldQueueModelCandidate(apiModel), false, apiModel);
  }
  assert.equal(shouldQueueModelCandidate("gpt-5.6-sol"), true);
});

test("preview, beta, experimental and EAP models never enter human review", () => {
  for (const apiModel of [
    "gpt-5.7-preview",
    "gemini-4-beta",
    "grok-5.experimental",
    "claude-opus-5-eap",
    "gpt-image-3-preview",
  ]) {
    assert.equal(isPrereleaseModel(apiModel), true, apiModel);
    assert.equal(shouldQueueModelCandidate(apiModel), false, apiModel);
  }
  for (const releaseStage of [
    "PUBLIC PREVIEW",
    "BETA",
    "EXPERIMENTAL",
    "EAP",
  ]) {
    assert.equal(
      isPrereleaseModel("provider-model-with-stable-id", releaseStage),
      true,
      releaseStage
    );
  }
  assert.equal(isPrereleaseModel("gpt-5.7", "stable"), false);
  assert.equal(shouldQueueModelCandidate("gpt-image-3"), true);
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
  assert.equal(assessment.product, "chat");
  assert.match(assessment.analysisKo, /최신 모델 API/);
  assert.match(assessment.analysisKo, /편입 가치/);
});

test("a current unserved image model is recommended for Image Studio review", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "gpt-image-3",
    providers: ["openai"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
  });
  assert.equal(assessment.priority, "recommended");
  assert.equal(assessment.kind, "image_generation");
  assert.equal(assessment.product, "image_generation");
  assert.match(assessment.analysisKo, /이미지 생성 후보/);
  assert.match(assessment.analysisKo, /품질·편집·해상도·속도/);
  assert.match(assessment.analysisKo, /최악 비용/);
});

test("an image family already in Tomverse is a profile update, not a duplicate", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "gpt-image-2",
    providers: ["openai"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: true,
  });
  assert.equal(assessment.priority, "no_action");
  assert.equal(assessment.kind, "image_generation");
  assert.match(assessment.analysisKo, /이미지 생성 원장/);
});

test("a legacy prerelease item is marked no-action under the stable-only policy", () => {
  for (const apiModel of ["gpt-5.7-beta", "gpt-image-3-experimental"]) {
    const assessment = assessModelLifecycleItem({
      action: "add",
      apiModel,
      providers: ["openai"],
      availability: "current",
      lifecycle: null,
      servedByTomverse: false,
    });
    assert.equal(assessment.priority, "no_action", apiModel);
    assert.match(assessment.analysisKo, /후보에서 제외/);
  }
});

test("a new Google chat model carries the Brave app-managed search requirement", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "gemini-3.8-flash",
    providers: ["google"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
  });
  assert.equal(assessment.product, "chat");
  assert.match(assessment.analysisKo, /Brave app-managed/);
  assert.match(assessment.analysisKo, /function tool/);
});

test("a search-only id is not confused with the Google Brave model path", () => {
  assert.equal(isSearchSpecializedModel("gpt-5-search-api"), true);
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "gpt-5-search-api",
    providers: ["openai"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
  });
  assert.equal(assessment.priority, "no_action");
  assert.equal(assessment.product, "unsupported");
  assert.match(assessment.analysisKo, /일반 Gemini 모델/);
  assert.match(assessment.analysisKo, /Brave API/);
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

test("the short spellings of a release stage are prerelease too", () => {
  for (const apiModel of [
    "gemini-3-pro-exp-02-05",
    "deepseek-v3.2-exp",
    "gpt-5.6-alpha",
    "grok-5-rc1",
    "claude-opus-6-nightly",
    "mistral-next-canary",
    "gpt-5.7-early-access",
  ]) {
    assert.equal(isPrereleaseModel(apiModel), true, apiModel);
    assert.equal(shouldQueueModelCandidate(apiModel), false, apiModel);
  }
});

test("a stage word inside a longer word is not a stage", () => {
  // `expert` contains `exp`, `develop` contains `dev`, and a model whose name
  // merely embeds those letters is a model a provider serves. Excluding one is
  // silent, so the boundary matters more than the breadth of the list.
  for (const apiModel of [
    "expert-router-2",
    "gpt-5.6",
    "claude-opus-5",
    "qwen3-max",
  ]) {
    assert.equal(isPrereleaseModel(apiModel), false, apiModel);
    assert.equal(shouldQueueModelCandidate(apiModel), true, apiModel);
  }
});

test("words a provider uses for shipped models are left alone", () => {
  // FLUX.1-dev is a released weight and a speculative-decoding `-draft` model
  // is one half of a production setup. Neither is a release stage.
  assert.equal(isPrereleaseModel("flux.1-dev"), false);
  assert.equal(isPrereleaseModel("llama-3.3-70b-draft"), false);
});

test("a date inside the name does not make a new family every month", () => {
  assert.equal(
    candidateFamilyIdentity("gemini-2.5-flash-preview-05-20"),
    candidateFamilyIdentity("gemini-2.5-flash-preview-09-2026")
  );
  assert.equal(
    candidateFamilyIdentity("gemini-2.5-flash-preview-05-20"),
    "gemini-2.5-flash"
  );
  assert.equal(
    candidateFamilyIdentity("openai/gpt-5.6-2026-01-15-preview-latest"),
    "gpt-5.6"
  );
});

test("a two-digit date is a date and a version number is not", () => {
  assert.equal(candidateFamilyIdentity("claude-opus-4-6"), "claude-opus-4-6");
  assert.equal(candidateFamilyIdentity("gpt-5.5"), "gpt-5.5");
  assert.equal(candidateFamilyIdentity("gpt-5.6"), "gpt-5.6");
});

test("a decision about a preview does not answer for the release", () => {
  const previewDecision = candidateDecisionKey("gemini-2.5-flash-preview-05-20");
  const releaseDecision = candidateDecisionKey("gemini-2.5-flash");
  assert.notEqual(previewDecision, releaseDecision);
  // The release is still an open question after the preview was declined.
  assert.equal(
    decisionSuppressesCandidate(previewDecision, "gemini-2.5-flash"),
    false
  );
  // Declining the release does answer for its previews.
  assert.equal(
    decisionSuppressesCandidate(releaseDecision, "gemini-2.5-flash-preview-09-2026"),
    true
  );
  assert.equal(
    decisionSuppressesCandidate(releaseDecision, "gemini-2.5-flash"),
    true
  );
});

test("a key written before stages existed still suppresses what it did", () => {
  assert.equal(decisionSuppressesCandidate("gpt-5.6", "gpt-5.6"), true);
  assert.equal(decisionSuppressesCandidate("gpt-5.6", "gpt-5.5"), false);
});

test("a model line keeps its tier and loses its generation", () => {
  assert.deepEqual(modelLine("claude-opus-4-6"), {
    line: "claude-opus",
    version: [4, 6],
  });
  assert.deepEqual(modelLine("claude-opus-5"), {
    line: "claude-opus",
    version: [5],
  });
  assert.deepEqual(modelLine("gemini-2.5-flash"), {
    line: "gemini-flash",
    version: [2, 5],
  });
  assert.deepEqual(modelLine("qwen3-max"), { line: "qwen-max", version: [3] });
  assert.deepEqual(modelLine("gpt-5.6-mini"), {
    line: "gpt-mini",
    version: [5, 6],
  });
});

test("a name this cannot read has no version, and is never superseded", () => {
  assert.equal(modelLine("gpt-4o").version, null);
  assert.equal(supersedingServedModel("gpt-4o", ["gpt-5.6"]), null);
  assert.equal(supersedingServedModel("sonar", ["sonar-pro"]), null);
});

test("an older generation of a served line is superseded by name", () => {
  const served = ["claude-opus-5", "claude-sonnet-5", "gpt-5.6"];
  assert.equal(
    supersedingServedModel("claude-opus-4-6", served),
    "claude-opus-5"
  );
  assert.equal(
    supersedingServedModel("claude-opus-4-7", served),
    "claude-opus-5"
  );
  assert.equal(
    supersedingServedModel("anthropic/claude-opus-4-6-20260514", served),
    "claude-opus-5"
  );
});

test("a newer generation and a different tier are not superseded", () => {
  const served = ["claude-opus-5", "gpt-5.6"];
  assert.equal(supersedingServedModel("claude-opus-5-1", served), null);
  assert.equal(supersedingServedModel("gpt-5.6-mini", served), null);
  assert.equal(supersedingServedModel("claude-haiku-4-6", served), null);
});

test("the review says which served model the candidate is behind", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "claude-opus-4-6",
    providers: ["anthropic"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    supersededBy: "claude-opus-5",
  });
  assert.equal(assessment.priority, "no_action");
  assert.equal(assessment.kind, "superseded_version");
  assert.match(assessment.analysisKo, /claude-opus-5/);
});

test("only the newest generation of a line survives one scan", () => {
  const kept = newestByModelLine(
    ["claude-opus-4-6", "claude-opus-5", "gpt-4o"],
    (value) => value
  );
  assert.deepEqual(kept, ["claude-opus-5", "gpt-4o"]);
});
