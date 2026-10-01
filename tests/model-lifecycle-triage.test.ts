import assert from "node:assert/strict";
import test from "node:test";
import {
  assessModelLifecycleItem,
  modelGenerationFamily,
  modelPortfolioRelation,
  modelTier,
  candidateDecisionKey,
  candidateFamilyIdentity,
  candidateRepresentativeRank,
  decisionSuppressesCandidate,
  decisionSuppressesCandidateIdentity,
  isImageGenerationModel,
  isMultiAgentModel,
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

test("a current chat candidate is compared with the active same-owner portfolio", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "gpt-5.6-sol",
    providers: ["openai"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    candidateEvidence: {
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
      supportsImage: true,
      reasoning: true,
    },
    servedModels: [
      {
        provider: "openai",
        apiModel: "gpt-5.5-thinking",
        name: "GPT 5.5 Thinking",
        reasoning: "high",
        contextWindowTokens: 400_000,
        maxOutputTokens: 64_000,
        supportsImage: true,
        product: "chat",
      },
    ],
  });
  assert.equal(assessment.priority, "recommended");
  assert.equal(assessment.kind, "general_chat");
  assert.equal(assessment.product, "chat");
  assert.match(assessment.analysisKo, /GPT 5\.5 Thinking/);
  assert.match(assessment.analysisKo, /컨텍스트가/);
  assert.match(assessment.analysisKo, /최대 출력/);
});

test("a non-reasoning xAI candidate explains the real Grok portfolio gap", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "grok-4.20-non-reasoning",
    providers: ["xai"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    candidateEvidence: {
      reasoning: false,
      observedInputUsdPerMillionTokens: 2,
      observedOutputUsdPerMillionTokens: 8,
    },
    servedModels: [
      {
        provider: "xai",
        apiModel: "grok-4.5",
        name: "Grok 4.5",
        reasoning: "high",
        contextWindowTokens: 500_000,
        supportsImage: true,
        product: "chat",
      },
    ],
  });
  assert.equal(assessment.priority, "recommended");
  assert.match(assessment.analysisKo, /Grok 4\.5/);
  assert.match(assessment.analysisKo, /현재 라인업에 없는 역할/);
  assert.match(assessment.analysisKo, /입력 \$2\/출력 \$8/);
});

test("a reasoning xAI candidate is not presented as a missing reasoning slot", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "grok-4.20-reasoning",
    providers: ["xai"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    candidateEvidence: { reasoning: true },
    servedModels: [
      {
        provider: "xai",
        apiModel: "grok-4.5",
        name: "Grok 4.5",
        reasoning: "high",
        product: "chat",
      },
    ],
  });
  assert.notEqual(assessment.priority, "recommended");
  assert.match(assessment.analysisKo, /Grok 4\.5/);
  assert.match(assessment.analysisKo, /역할이 겹칩니다/);
  assert.match(assessment.analysisKo, /품질은 모델 목록에서 알 수 없으므로/);
});

test("a latency tier remains a portfolio role even when it supports thinking", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "gemini-4-flash",
    providers: ["google"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    candidateEvidence: { reasoning: true },
    servedModels: [
      {
        provider: "google",
        apiModel: "gemini-4-pro",
        name: "Gemini 4 Pro",
        reasoning: "high",
        product: "chat",
      },
    ],
  });
  assert.equal(assessment.priority, "recommended");
  assert.match(assessment.analysisKo, /속도·비용형/);
  assert.match(assessment.analysisKo, /현재 라인업에 없는 역할/);
});

test("an unclassified served role prevents a false portfolio-gap claim", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "mistral-medium-4",
    providers: ["mistral"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    candidateEvidence: { reasoning: false },
    servedModels: [
      {
        provider: "mistral",
        apiModel: "mistral-medium-3.5",
        name: "Mistral Medium 3.5",
        reasoning: null,
        product: "chat",
      },
    ],
  });
  // The served role is unclassified, so no portfolio gap may be claimed. The
  // generation is a different fact and the ids do state it: medium 4 follows
  // medium 3.5, which is what an operator needs before anything else.
  assert.equal(assessment.priority, "recommended");
  assert.doesNotMatch(assessment.analysisKo, /현재 라인업에 없는 역할/);
  assert.match(assessment.verdictKo, /상위 세대/);
  assert.match(assessment.verdictKo, /Mistral Medium 3\.5/);
});

test("a new Anthropic tier names the existing lineup and missing decision evidence", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "claude-fable-5-1",
    providers: ["anthropic"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    candidateEvidence: {
      contextWindowTokens: 500_000,
      maxOutputTokens: 64_000,
      supportsImage: true,
      observedInputUsdPerMillionTokens: 2.5,
      observedOutputUsdPerMillionTokens: 12.5,
      priceEvidenceSource: "provider_docs",
    },
    servedModels: [
      {
        provider: "anthropic",
        apiModel: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        reasoning: "medium",
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 128_000,
        supportsImage: true,
        inputUsdPerMillionTokens: 3,
        outputUsdPerMillionTokens: 15,
        product: "chat",
      },
      {
        provider: "anthropic",
        apiModel: "claude-opus-5",
        name: "Claude Opus 5",
        reasoning: "high",
        product: "chat",
      },
    ],
  });
  assert.match(assessment.analysisKo, /Claude Sonnet 5/);
  assert.match(assessment.analysisKo, /Claude Opus 5/);
  assert.match(assessment.analysisKo, /컨텍스트가 .*보다 작음/);
  assert.match(assessment.analysisKo, /공식 문서 관측 가격/);
  assert.match(assessment.analysisKo, /단가 .*보다 낮음/);
  assert.doesNotMatch(assessment.analysisKo, /품질·가격·컨텍스트 이점이 확인되면/);
});

test("an aggregator sighting compares by model maker, not scanning provider", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "perplexity/claude-fable-5-1",
    providers: ["perplexity"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    servedModels: [
      {
        provider: "openai",
        apiModel: "gpt-5.6-sol",
        name: "GPT 5.6 Sol",
        product: "chat",
      },
      {
        provider: "anthropic",
        apiModel: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        product: "chat",
      },
    ],
  });
  assert.match(assessment.analysisKo, /Claude Sonnet 5/);
  assert.doesNotMatch(assessment.analysisKo, /GPT 5\.6 Sol/);
});

test("an unknown maker is not silently equated with an aggregator portfolio", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "perplexity/new-family-7",
    providers: ["perplexity"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    servedModels: [
      {
        provider: "perplexity",
        apiModel: "sonar-pro",
        name: "Sonar Pro",
        product: "chat",
      },
    ],
  });
  assert.equal(assessment.priority, "needs_evidence");
  assert.match(assessment.analysisKo, /제작사를 식별하지 못해/);
  assert.doesNotMatch(assessment.analysisKo, /Sonar Pro/);
});

test("a current model with an empty lineup stays in review until the catalogue has decision facts", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "gpt-queue-current",
    providers: ["openai"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    servedModels: [],
  });
  assert.equal(assessment.priority, "review");
  assert.match(
    assessment.analysisKo,
    /openai의 모델 목록은 이 후보의 컨텍스트·출력·모달리티·가격을 담고 있지 않습니다/
  );
});

test("provider aliases are explained as one adoption decision", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "grok-4.20-non-reasoning",
    providers: ["xai"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    candidateEvidence: {
      canonicalApiModel: "grok-4.20-non-reasoning-gv2",
      equivalentApiModels: [
        "grok-4.20-non-reasoning-gv2",
        "grok-4.20-non-reasoning",
      ],
      reasoning: false,
    },
    servedModels: [],
  });
  assert.match(assessment.analysisKo, /동일 모델 alias/);
  assert.match(assessment.analysisKo, /한 개면 충분/);
});

test("multi-agent research models are not treated as ordinary chat", () => {
  assert.equal(isMultiAgentModel("grok-4.20-multi-agent"), true);
  assert.equal(modelProductSurface("grok-4.20-multi-agent"), "unsupported");
  assert.equal(shouldQueueModelCandidate("grok-4.20-multi-agent"), false);
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "grok-4.20-multi-agent",
    providers: ["xai"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
  });
  assert.equal(assessment.priority, "no_action");
  assert.match(assessment.analysisKo, /Responses API/);
  assert.match(assessment.verdictKo, /등록하면 동작하지 않습니다/);
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
  assert.match(assessment.analysisKo, /Studio/);
  assert.match(assessment.analysisKo, /동일 프롬프트 품질/);
  assert.match(assessment.analysisKo, /실제 지연시간/);
  assert.match(assessment.analysisKo, /최악 비용/);
});

test("unknown image makers are not grouped together as one Studio vendor", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "black-forest-labs/flux-2-image",
    providers: ["fal"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    servedModels: [
      {
        provider: "fal",
        apiModel: "fal-ai/nano-banana-2",
        name: "Nano Banana 2",
        product: "image_generation",
      },
    ],
  });
  assert.equal(assessment.priority, "needs_evidence");
  assert.match(assessment.analysisKo, /제작사를 식별하지 못해/);
  assert.doesNotMatch(assessment.analysisKo, /Nano Banana 2/);
});

test("mixed input and output prices are described as a tradeoff", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "grok-4.30-reasoning",
    providers: ["xai"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    candidateEvidence: {
      reasoning: true,
      observedInputUsdPerMillionTokens: 1,
      observedOutputUsdPerMillionTokens: 20,
      priceEvidenceSource: "provider_api",
    },
    servedModels: [
      {
        provider: "xai",
        apiModel: "grok-4.5",
        name: "Grok 4.5",
        reasoning: "high",
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 10,
        product: "chat",
      },
    ],
  });
  assert.match(assessment.analysisKo, /가격.*엇갈림/);
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
    assert.match(assessment.nextStepKo, /제외합니다/, apiModel);
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
  assert.match(assessment.verdictKo, /제공 여부를 모릅니다/);
  assert.match(assessment.nextStepKo, /스캔이 한 번 성공한 뒤/);
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
  assert.match(assessment.nextStepKo, /대체 모델/);
  assert.match(assessment.nextStepKo, /저장해 둔 사용자/);
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

test("an alias-aware decision keeps prerelease stage semantics", () => {
  assert.equal(
    decisionSuppressesCandidateIdentity(
      "gemini-2.5-flash@prerelease",
      "gemini-2.5-flash",
      "prerelease"
    ),
    true
  );
  assert.equal(
    decisionSuppressesCandidateIdentity(
      "gemini-2.5-flash@prerelease",
      "gemini-2.5-flash",
      "stable"
    ),
    false
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

// The provider release wave that named this work: Zhipu's 2026-09-21 scan, with
// GLM 5.2 in the catalogue. Five ids arrived and the queue said the same
// paragraph about all five -- that it could not tell what any of them
// complements or replaces -- while the ids themselves said that two are older
// generations of the served model and one is the next generation of it.
const ZHIPU_WAVE = [
  "glm-4.5-air",
  "glm-5-turbo",
  "ZHIPU/GLM-5.3",
  "glm-5.3-flash",
  "glm-5.3-flashx",
];

const zhipuCandidate = (apiModel: string) =>
  assessModelLifecycleItem({
    action: "add",
    apiModel,
    providers: ["zhipu"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    candidateEvidence: null,
    servedModels: [
      {
        provider: "zhipu",
        apiModel: "glm-5.2",
        name: "GLM 5.2",
        reasoning: "high",
        product: "chat" as const,
      },
    ],
    siblingApiModels: ZHIPU_WAVE,
  });

test("a tier word is read the same way wherever it sits in the id", () => {
  assert.equal(modelTier("glm-4.5-air").kind, "economy");
  assert.equal(modelTier("glm-5.3-flashx").kind, "economy");
  assert.equal(modelTier("glm-5-turbo").kind, "speed");
  assert.equal(modelTier("claude-opus-5").kind, "flagship");
  assert.equal(modelTier("gemini-4-pro").kind, "flagship");
  // Absent is not "standard": the id declined to say.
  assert.equal(modelTier("glm-5.3").kind, null);
  assert.equal(modelTier("mistral-medium-4").kind, null);
  // Two tier words are one seat, not the first word repeated.
  assert.equal(modelTier("gemini-3.5-flash").word, "flash");
  assert.equal(modelTier("gemini-3.5-flash-lite").word, "flash-lite");
  assert.equal(modelTier("gemini-3.5-flash-lite").kind, "economy");
  // A gap is not a seat. The last consecutive run is the tier.
  assert.equal(modelTier("whisper-large-v3-turbo").word, "turbo");
  assert.equal(modelTier("whisper-large-v3-turbo").kind, "speed");
  assert.equal(modelTier("grok-3-mini-fast").word, "mini-fast");
  assert.equal(modelTier("grok-3-mini-fast").kind, "economy");
  assert.equal(modelTier("claude-opus-5-fast").word, "fast");
  assert.equal(modelTier("claude-opus-5-fast").kind, "speed");
});

test("a compound tier is not the same seat as its first word", () => {
  const served = [
    {
      provider: "google",
      apiModel: "gemini-3.5-flash",
      name: "Gemini 3.5 Flash",
      product: "chat" as const,
    },
  ];
  const relation = modelPortfolioRelation("gemini-3.5-flash-lite", served);
  assert.equal(relation.kind, "same_generation");
  assert.equal(relation.sameTier, false);
  assert.equal(relation.candidateTier.word, "flash-lite");
  assert.equal(modelGenerationFamily("gemini-3.5-flash-lite").family, "gemini");
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "gemini-3.5-flash-lite",
    providers: ["google"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    candidateEvidence: null,
    servedModels: served,
    siblingApiModels: ["gemini-3.5-flash"],
  });
  assert.equal(assessment.priority, "review");
  assert.doesNotMatch(assessment.verdictKo, /같은 자리를 놓고/);
  assert.ok(
    !assessment.pointsKo.some((point) => /한 글자 차이/.test(point)),
    assessment.pointsKo.join(" | ")
  );
});

test("a generation family drops the tier word that modelLine keeps", () => {
  // modelLine keeps the tier so "we already serve a later one of exactly this"
  // stays answerable; the family drops it so one release wave is one group.
  assert.equal(modelLine("glm-4.5-air").line, "glm-air");
  assert.equal(modelGenerationFamily("glm-4.5-air").family, "glm");
  assert.equal(modelGenerationFamily("glm-5.3-flashx").family, "glm");
  assert.equal(modelGenerationFamily("claude-opus-5").family, "claude");
  assert.deepEqual(modelGenerationFamily("glm-5.3").version, [5, 3]);
});

test("the relation names the served model it was measured against", () => {
  const served = [{ provider: "zhipu", apiModel: "glm-5.2", name: "GLM 5.2" }];
  const older = modelPortfolioRelation("glm-4.5-air", served);
  assert.equal(older.kind, "older_generation");
  assert.equal(older.candidateGeneration, "4.5");
  assert.equal(older.servedGeneration, "5.2");
  assert.equal(older.against?.apiModel, "glm-5.2");
  assert.equal(modelPortfolioRelation("ZHIPU/GLM-5.3", served).kind, "newer_generation");
  assert.equal(modelPortfolioRelation("glm-5.2", served).kind, "same_generation");
  // Another maker's model is never the thing this is measured against.
  assert.equal(modelPortfolioRelation("claude-opus-5", served).kind, "no_shared_family");
});

test("a cheaper served seat does not decide an unnamed base is already served", () => {
  const flashOnly = [
    { provider: "zhipu", apiModel: "glm-5.3-flash", name: "GLM 5.3 Flash" },
  ];
  const relation = modelPortfolioRelation("glm-5.2", flashOnly);
  assert.equal(relation.kind, "family_seat_mismatch");
  assert.equal(relation.candidateGeneration, "5.2");
  assert.equal(relation.against?.apiModel, "glm-5.3-flash");
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "glm-5.2",
    providers: ["zhipu"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    candidateEvidence: null,
    servedModels: [
      {
        provider: "zhipu",
        apiModel: "glm-5.3-flash",
        name: "GLM 5.3 Flash",
        reasoning: "high",
        product: "chat" as const,
      },
    ],
    siblingApiModels: [],
  });
  assert.equal(assessment.priority, "review");
  assert.match(assessment.verdictKo, /5\.2 세대/);
  assert.match(assessment.verdictKo, /더 낮은 자리/);
  assert.doesNotMatch(assessment.verdictKo, /확정되지 않아/);
  assert.doesNotMatch(assessment.nextStepKo, /편입 근거가 없습니다/);
});

test("a same-kind seat with a different word does not close its neighbour", () => {
  const liteOnly = [
    { provider: "google", apiModel: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite" },
  ];
  const relation = modelPortfolioRelation("gemini-3-flash", liteOnly);
  assert.equal(relation.kind, "family_seat_mismatch");
  assert.notEqual(relation.kind, "older_generation");
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "gemini-3-flash",
    providers: ["google"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    candidateEvidence: null,
    servedModels: [
      {
        provider: "google",
        apiModel: "gemini-3.5-flash-lite",
        name: "Gemini 3.5 Flash-Lite",
        reasoning: "high",
        product: "chat" as const,
      },
    ],
    siblingApiModels: [],
  });
  assert.notEqual(assessment.priority, "low");
  assert.match(assessment.verdictKo, /다른 자리/);
  assert.doesNotMatch(assessment.nextStepKo, /편입 근거가 없습니다/);
  assert.doesNotMatch(assessment.verdictKo, /확정되지 않아/);
});

test("a seat mismatch keeps a missing role on the recommended view", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "glm-5.2",
    providers: ["zhipu"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    candidateEvidence: { reasoning: true },
    servedModels: [
      {
        provider: "zhipu",
        apiModel: "glm-5.3-flash",
        name: "GLM 5.3 Flash",
        reasoning: "none",
        product: "chat" as const,
      },
    ],
    siblingApiModels: [],
  });
  assert.equal(assessment.priority, "recommended");
  assert.match(assessment.verdictKo, /더 낮은 자리/);
  assert.doesNotMatch(assessment.nextStepKo, /편입 근거가 없습니다/);
});

test("a queued base model keeps a seat mismatch off the recommended view", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "glm-5.3-plus",
    providers: ["zhipu"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    candidateEvidence: { reasoning: true },
    servedModels: [
      {
        provider: "zhipu",
        apiModel: "glm-5.2-air",
        name: "GLM 5.2 Air",
        reasoning: "none",
        product: "chat" as const,
      },
    ],
    siblingApiModels: ["glm-5.3", "glm-5.3-plus"],
  });
  assert.equal(assessment.priority, "review");
  assert.match(assessment.verdictKo, /다른 자리|더 낮은 자리/);
});

test("a preview queued beside a derivative is not the base model", () => {
  const assessment = assessModelLifecycleItem({
    action: "add",
    apiModel: "o1-mini",
    providers: ["openai"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    candidateEvidence: { reasoning: true },
    servedModels: [
      {
        provider: "openai",
        apiModel: "gpt-5",
        name: "GPT-5",
        reasoning: "high",
        product: "chat" as const,
      },
    ],
    siblingApiModels: ["o1-preview", "o1-mini"],
  });
  assert.equal(assessment.priority, "recommended");
  assert.ok(
    !assessment.pointsKo.some((point) => /기본형 'o1-preview'/.test(point)),
    assessment.pointsKo.join(" | ")
  );
});

test("a preview sibling is not named as a derivative to decide with", () => {
  const base = assessModelLifecycleItem({
    action: "add",
    apiModel: "gpt-5.7",
    providers: ["openai"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    candidateEvidence: null,
    servedModels: [],
    siblingApiModels: ["gpt-5.7", "gpt-5.7-mini-preview"],
  });
  assert.ok(
    !base.pointsKo.some((point) => /gpt-5\.7-mini-preview/.test(point)),
    base.pointsKo.join(" | ")
  );
  const flash = assessModelLifecycleItem({
    action: "add",
    apiModel: "glm-5.3-flash",
    providers: ["zhipu"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    candidateEvidence: null,
    servedModels: [],
    siblingApiModels: ["glm-5.3-flash", "glm-5.3-flashx-preview"],
  });
  assert.ok(
    !flash.pointsKo.some((point) => /한 글자/.test(point)),
    flash.pointsKo.join(" | ")
  );
});

test("an older generation of a served family is a decided row, not an open question", () => {
  for (const apiModel of ["glm-4.5-air", "glm-5-turbo"]) {
    const assessment = zhipuCandidate(apiModel);
    assert.equal(assessment.priority, "low", apiModel);
    assert.match(assessment.verdictKo, /GLM 5\.2/, apiModel);
    assert.match(assessment.verdictKo, /세대/, apiModel);
    assert.match(assessment.nextStepKo, /편입 근거가 없습니다/, apiModel);
  }
  assert.match(zhipuCandidate("glm-4.5-air").verdictKo, /4\.5 세대/);
  assert.match(zhipuCandidate("glm-5-turbo").verdictKo, /속도 지향/);
});

test("the next generation of the served line is the row an operator came for", () => {
  const assessment = zhipuCandidate("ZHIPU/GLM-5.3");
  assert.equal(assessment.priority, "recommended");
  assert.match(assessment.verdictKo, /상위 세대 5\.3/);
  assert.match(assessment.verdictKo, /대체할 후보/);
  // What is missing is named, rather than "check the official positioning".
  assert.match(assessment.nextStepKo, /컨텍스트 창/);
  assert.match(assessment.nextStepKo, /입력\/출력 단가/);
});

test("a derivative of a wave points at the base model queued beside it", () => {
  const flash = zhipuCandidate("glm-5.3-flash");
  // Never louder than the base model it depends on, even when its role is
  // missing from the lineup: deciding the base decides this one's seat.
  assert.equal(flash.priority, "review");
  assert.match(flash.verdictKo, /경량·저가 파생형/);
  assert.ok(
    flash.pointsKo.some((point) => /기본형 'ZHIPU\/GLM-5\.3'/.test(point)),
    flash.pointsKo.join(" | ")
  );
  // flash and flashx differ by one letter: the queue raises the question and
  // leaves the answer to the provider's documentation.
  assert.ok(
    flash.pointsKo.some((point) => /속도·가격 SKU일 수 있습니다/.test(point)),
    flash.pointsKo.join(" | ")
  );
  assert.ok(
    zhipuCandidate("glm-5.3-flashx").pointsKo.some((point) =>
      /glm-5\.3-flash'/.test(point)
    )
  );
});

test("one release wave produces five different answers", () => {
  const verdicts = ZHIPU_WAVE.map((apiModel) => zhipuCandidate(apiModel).verdictKo);
  const priorities = ZHIPU_WAVE.map((apiModel) => zhipuCandidate(apiModel).priority);
  // The defect this replaces: one paragraph, five times, one priority.
  assert.ok(new Set(verdicts).size >= 3, verdicts.join("\n"));
  assert.ok(new Set(priorities).size >= 3, priorities.join(","));
  // And the analysis an exclusion records is still one string, built from the
  // three parts rather than written twice.
  for (const apiModel of ZHIPU_WAVE) {
    const assessment = zhipuCandidate(apiModel);
    assert.equal(
      assessment.analysisKo,
      [assessment.verdictKo, ...assessment.pointsKo, assessment.nextStepKo].join(" ")
    );
  }
});

test("a wave with no base model queued leaves the derivative on its own merits", () => {
  const flashAlone = assessModelLifecycleItem({
    action: "add",
    apiModel: "glm-5.3-flash",
    providers: ["zhipu"],
    availability: "current",
    lifecycle: null,
    servedByTomverse: false,
    servedModels: [
      {
        provider: "zhipu",
        apiModel: "glm-5.2",
        name: "GLM 5.2",
        reasoning: "high",
        product: "chat" as const,
      },
    ],
    siblingApiModels: ["glm-5.3-flash"],
  });
  assert.equal(flashAlone.priority, "recommended");
  assert.ok(
    !flashAlone.pointsKo.some((point) => /기본형/.test(point)),
    flashAlone.pointsKo.join(" | ")
  );
});
