/**
 * Evidence-backed triage for models observed in provider catalogues.
 *
 * This module is deliberately pure. The catalogue reader establishes whether
 * a model is still present; these functions only turn that evidence and the
 * model id into a review priority and a short Korean explanation. No model is
 * closed automatically from this suggestion.
 */

export const MODEL_REVIEW_PRIORITIES = [
  "recommended",
  "review",
  "needs_evidence",
  "low",
  "no_action",
] as const;
export type ModelReviewPriority = (typeof MODEL_REVIEW_PRIORITIES)[number];

export const MODEL_REVIEW_KINDS = [
  "retirement",
  "general_chat",
  "image_generation",
  "dated_snapshot",
  "moving_alias",
  "preview",
  "specialized_code",
  "specialized_non_chat",
] as const;
export type ModelReviewKind = (typeof MODEL_REVIEW_KINDS)[number];

export const MODEL_PRODUCT_SURFACES = [
  "chat",
  "image_generation",
  "unsupported",
] as const;
export type ModelProductSurface = (typeof MODEL_PRODUCT_SURFACES)[number];

export type ModelAvailability = "current" | "stale" | "unknown";

export const modelIdentityWithoutVendor = (apiModel: string) => {
  const withoutVendor = apiModel.slice(apiModel.lastIndexOf("/") + 1);
  return withoutVendor.trim().toLowerCase();
};

const DATED_SUFFIXES = [
  /-(?:20\d{2})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/,
  /-(?:20\d{6})$/,
  /-(?:0\d|1[0-2])(?:0\d|[12]\d|3[01])$/,
  /-(?:00[1-9]|0[1-9]\d)$/,
] as const;

const stripOneDatedSuffix = (value: string) => {
  for (const pattern of DATED_SUFFIXES) {
    if (pattern.test(value)) return value.replace(pattern, "");
  }
  return value;
};

export const isDatedModelSnapshot = (apiModel: string) => {
  const identity = modelIdentityWithoutVendor(apiModel);
  const withoutStage = identity.replace(/-(?:preview|beta|eap)$/, "");
  return stripOneDatedSuffix(withoutStage) !== withoutStage;
};

export const isMovingModelAlias = (apiModel: string) =>
  /(?:-|@)(?:latest|auto)$/.test(modelIdentityWithoutVendor(apiModel));

export const isPreviewModel = (apiModel: string) =>
  /(?:^|[-_.])(?:preview|beta|eap|experimental)(?:$|[-_.])/.test(
    modelIdentityWithoutVendor(apiModel)
  );

export const isCodeSpecializedModel = (apiModel: string) =>
  /(?:^|[-_.])(?:codex|coder|code)(?:$|[-_.])/.test(
    modelIdentityWithoutVendor(apiModel)
  );

/** Models whose primary output is an image, not models that merely accept one. */
export const isImageGenerationModel = (apiModel: string) =>
  /(?:^|[-_.:/])(?:image|images|imagegen|imagen|imagine|dall-e|flux|recraft|ideogram|seedream|stable-diffusion|sdxl|sd3|nano-banana|photon|hidream)(?:$|[-_.:/])/.test(
    modelIdentityWithoutVendor(apiModel)
  );

export const isSearchSpecializedModel = (apiModel: string) =>
  /(?:^|[-_.])(?:search)(?:$|[-_.])/.test(
    modelIdentityWithoutVendor(apiModel)
  );

/** Products whose endpoint is not implemented by either Chat or Image Studio. */
export const isSpecializedNonChatModel = (apiModel: string) =>
  !isImageGenerationModel(apiModel) &&
  /(?:^|[-_.])(?:audio|realtime|search|transcrib(?:e|er)|transcription|speech|tts|embedding|embed|moderation|rerank|video|veo|whisper|guard|safeguard)(?:$|[-_.])/.test(
    modelIdentityWithoutVendor(apiModel)
  );

export const modelProductSurface = (apiModel: string): ModelProductSurface => {
  if (isImageGenerationModel(apiModel)) return "image_generation";
  if (isSpecializedNonChatModel(apiModel)) return "unsupported";
  return "chat";
};

/**
 * The identity a catalogue decision is grouped under.
 *
 * Provider prefixes, dated snapshots and moving aliases are observations of a
 * model family, not three independent reasons to ask an operator for a choice.
 * Semantic generations (for example gpt-5.5 and gpt-5.6) remain distinct.
 */
export const candidateFamilyIdentity = (apiModel: string) => {
  let identity = modelIdentityWithoutVendor(apiModel);
  identity = identity.replace(/(?:-|@)(?:latest|auto)$/, "");
  identity = identity.replace(/-(?:preview|beta|eap|experimental)$/, "");
  identity = stripOneDatedSuffix(identity);
  // A dated preview commonly has the stage after the date; remove the second
  // layer only after proving the first transformation changed the value.
  identity = identity.replace(/-(?:preview|beta|eap|experimental)$/, "");
  identity = stripOneDatedSuffix(identity);
  return identity;
};

/** Stable models are preferable representatives to their aliases/snapshots. */
export const candidateRepresentativeRank = (apiModel: string) => {
  if (modelProductSurface(apiModel) === "unsupported") return 5;
  if (isCodeSpecializedModel(apiModel)) return 4;
  if (isPreviewModel(apiModel)) return 3;
  if (isMovingModelAlias(apiModel)) return 2;
  if (isDatedModelSnapshot(apiModel)) return 1;
  return 0;
};

/** Chat and Image Studio candidates enter review; unsupported products do not. */
export const shouldQueueModelCandidate = (apiModel: string) =>
  modelProductSurface(apiModel) !== "unsupported";

const providerLabel = (providers: readonly string[]) => {
  const unique = Array.from(new Set(providers.filter(Boolean)));
  if (unique.length === 0) return "공급자";
  if (unique.length === 1) return unique[0];
  return `${unique[0]} 외 ${unique.length - 1}곳`;
};

export type ModelTriageAssessment = {
  priority: ModelReviewPriority;
  kind: ModelReviewKind;
  product: ModelProductSurface;
  analysisKo: string;
};

export const assessModelLifecycleItem = (input: {
  action: string;
  apiModel: string;
  providers: readonly string[];
  availability: ModelAvailability;
  lifecycle: string | null;
  servedByTomverse: boolean;
}): ModelTriageAssessment => {
  const provider = providerLabel(input.providers);
  const product = modelProductSurface(input.apiModel);
  const googleBraveSearchNote = input.providers.includes("google")
    ? " Google 모델의 웹검색은 별도 검색 모델이 아니라 function tool 지원을 확인한 뒤 Tomverse의 Brave app-managed 경로에 등록해야 합니다."
    : "";

  if (input.action === "retire") {
    return {
      priority: "recommended",
      kind: "retirement",
      product,
      analysisKo:
        `${provider} 카탈로그에서 더 이상 확인되지 않은 Tomverse 제공 모델입니다. ` +
        "대체 모델과 사용자 영향 여부를 우선 검토해야 합니다.",
    };
  }
  if (input.lifecycle) {
    return {
      priority: "no_action",
      kind: product === "image_generation" ? "image_generation" : "general_chat",
      product,
      analysisKo:
        `${provider}가 '${input.lifecycle}' 수명주기를 명시한 모델입니다. ` +
        "신규 편입 근거가 없으며 종료 또는 대체 정보를 확인하는 편이 적절합니다.",
    };
  }
  if (input.availability === "stale") {
    return {
      priority: "no_action",
      kind: product === "image_generation" ? "image_generation" : "general_chat",
      product,
      analysisKo:
        `${provider}의 최신 성공 모델 API 응답에서 더 이상 확인되지 않습니다. ` +
        "현재 제공 근거가 없어 신규 편입 대상으로 권장하지 않습니다.",
    };
  }
  if (product === "unsupported") {
    if (isSearchSpecializedModel(input.apiModel)) {
      return {
        priority: "no_action",
        kind: "specialized_non_chat",
        product,
        analysisKo:
          "검색 전용 모델 또는 엔드포인트로 보입니다. Tomverse의 Google 웹검색은 일반 Gemini 모델이 Brave API function tool을 호출하는 app-managed 경로이므로, " +
          "이 ID를 직접 추가하기보다 일반 채팅 모델의 도구 호출 호환성과 웹검색 capability 등록을 검토해야 합니다.",
      };
    }
    return {
      priority: "no_action",
      kind: "specialized_non_chat",
      product,
      analysisKo:
        "음성·검색 등 현재 Tomverse의 모델 제품 범위 밖 엔드포인트용 모델로 보입니다. " +
        "지원 제품이 확정되기 전에는 카탈로그 편입을 권장하지 않습니다.",
    };
  }
  if (product === "image_generation") {
    if (input.servedByTomverse) {
      return {
        priority: "no_action",
        kind: "image_generation",
        product,
        analysisKo:
          "같은 이미지 모델 패밀리가 이미 Tomverse 이미지 생성 원장에 있습니다. " +
          "중복 추가보다 기존 프로필의 공급자·가격·활성 상태를 갱신하는 편이 적절합니다.",
      };
    }
    if (input.availability === "unknown") {
      return {
        priority: "needs_evidence",
        kind: "image_generation",
        product,
        analysisKo:
          `${provider}의 최근 모델 API 확인이 실패했거나 실행 이력이 없습니다. ` +
          "Tomverse 이미지 생성 후보로 검토하기 전에 현재 제공 여부를 다시 확인해야 합니다.",
      };
    }
    if (isPreviewModel(input.apiModel)) {
      return {
        priority: "low",
        kind: "image_generation",
        product,
        analysisKo:
          `${provider}에서 확인되는 미리보기 이미지 생성 모델입니다. ` +
          "Studio 편입 전 지원 종료 조건과 이미지당 최악 비용, 품질·편집·해상도 이점을 검증해야 합니다.",
      };
    }
    return {
      priority: "recommended",
      kind: "image_generation",
      product,
      analysisKo:
        `${provider}의 최신 모델 API에서 확인되는 Tomverse 이미지 생성 후보입니다. ` +
        "현재 Studio 모델 대비 품질·편집·해상도·속도 이점과 이미지당 최악 비용, 공급자 연동 가능성을 비교할 가치가 있습니다.",
    };
  }
  if (input.servedByTomverse) {
    return {
      priority: "no_action",
      kind: "general_chat",
      product,
      analysisKo:
        "같은 모델 패밀리가 이미 Tomverse 카탈로그에서 제공되고 있습니다. " +
        "별도 모델로 추가하기보다 기존 항목의 공급자·별칭 정보로 관리하는 편이 적절합니다.",
    };
  }
  if (input.availability === "unknown") {
    return {
      priority: "needs_evidence",
      kind: "general_chat",
      product,
      analysisKo:
        `${provider}의 최근 모델 API 확인이 실패했거나 실행 이력이 없습니다. ` +
        "현재 제공 여부를 확인하기 전에는 편입 여부를 결정하기 어렵습니다.",
    };
  }
  if (isMovingModelAlias(input.apiModel)) {
    return {
      priority: "review",
      kind: "moving_alias",
      product,
      analysisKo:
        `${provider}의 최신 모델 API에서 확인되는 이동형 별칭입니다. ` +
        "가리키는 버전이 바뀔 수 있으므로 고정 버전과 함께 한 패밀리로 검토해야 합니다." +
        googleBraveSearchNote,
    };
  }
  if (isDatedModelSnapshot(input.apiModel)) {
    return {
      priority: "review",
      kind: "dated_snapshot",
      product,
      analysisKo:
        `${provider}의 최신 모델 API에서 확인되는 날짜·리비전 고정 스냅샷입니다. ` +
        "같은 패밀리의 안정 버전과 묶어 재현성 또는 호환성 필요가 있을 때만 편입할 가치가 있습니다." +
        googleBraveSearchNote,
    };
  }
  if (isPreviewModel(input.apiModel)) {
    return {
      priority: "low",
      kind: "preview",
      product,
      analysisKo:
        `${provider}의 최신 모델 API에서 확인되지만 미리보기·실험 단계입니다. ` +
        "안정성·가격·지원 종료 조건을 확인한 뒤 제한적으로 검토하는 편이 안전합니다." +
        googleBraveSearchNote,
    };
  }
  if (isCodeSpecializedModel(input.apiModel)) {
    return {
      priority: "low",
      kind: "specialized_code",
      product,
      analysisKo:
        `${provider}의 최신 모델 API에서 확인되는 코드 작업 특화 모델입니다. ` +
        "Tomverse Chat의 일반 대화 수요와 별개로 코딩 제품 범위가 확정될 때 편입 가치가 있습니다.",
    };
  }
  return {
    priority: "recommended",
    kind: "general_chat",
    product,
    analysisKo:
      `${provider}의 최신 모델 API에서 현재 확인되며 Tomverse가 아직 제공하지 않는 일반 대화 모델입니다. ` +
      "기존 모델 대비 품질·가격·컨텍스트 이점이 확인되면 편입 가치가 있습니다." +
      googleBraveSearchNote,
  };
};
