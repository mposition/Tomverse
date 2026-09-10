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
  "dated_snapshot",
  "moving_alias",
  "preview",
  "specialized_code",
  "specialized_non_chat",
] as const;
export type ModelReviewKind = (typeof MODEL_REVIEW_KINDS)[number];

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

/** Products whose endpoint or interaction contract is not Tomverse Chat. */
export const isSpecializedNonChatModel = (apiModel: string) =>
  /(?:^|[-_.])(?:audio|image|realtime|search|transcrib(?:e|er)|transcription|speech|tts|embedding|embed|moderation|rerank|video|veo|imagen|dall-e|whisper|guard|safeguard)(?:$|[-_.])/.test(
    modelIdentityWithoutVendor(apiModel)
  );

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
  if (isSpecializedNonChatModel(apiModel)) return 5;
  if (isCodeSpecializedModel(apiModel)) return 4;
  if (isPreviewModel(apiModel)) return 3;
  if (isMovingModelAlias(apiModel)) return 2;
  if (isDatedModelSnapshot(apiModel)) return 1;
  return 0;
};

/** Raw catalogue observations remain stored; these products skip only review. */
export const shouldQueueModelCandidate = (apiModel: string) =>
  !isSpecializedNonChatModel(apiModel);

const providerLabel = (providers: readonly string[]) => {
  const unique = Array.from(new Set(providers.filter(Boolean)));
  if (unique.length === 0) return "공급자";
  if (unique.length === 1) return unique[0];
  return `${unique[0]} 외 ${unique.length - 1}곳`;
};

export type ModelTriageAssessment = {
  priority: ModelReviewPriority;
  kind: ModelReviewKind;
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

  if (input.action === "retire") {
    return {
      priority: "recommended",
      kind: "retirement",
      analysisKo:
        `${provider} 카탈로그에서 더 이상 확인되지 않은 Tomverse 제공 모델입니다. ` +
        "대체 모델과 사용자 영향 여부를 우선 검토해야 합니다.",
    };
  }
  if (input.lifecycle) {
    return {
      priority: "no_action",
      kind: "general_chat",
      analysisKo:
        `${provider}가 '${input.lifecycle}' 수명주기를 명시한 모델입니다. ` +
        "신규 편입 근거가 없으며 종료 또는 대체 정보를 확인하는 편이 적절합니다.",
    };
  }
  if (input.availability === "stale") {
    return {
      priority: "no_action",
      kind: "general_chat",
      analysisKo:
        `${provider}의 최신 성공 모델 API 응답에서 더 이상 확인되지 않습니다. ` +
        "현재 제공 근거가 없어 신규 편입 대상으로 권장하지 않습니다.",
    };
  }
  if (isSpecializedNonChatModel(input.apiModel)) {
    return {
      priority: "no_action",
      kind: "specialized_non_chat",
      analysisKo:
        "이미지·음성·검색 등 별도 제품 또는 엔드포인트용 모델로 보입니다. " +
        "Tomverse Chat의 일반 대화 모델 후보로 편입할 이유가 낮습니다.",
    };
  }
  if (input.servedByTomverse) {
    return {
      priority: "no_action",
      kind: "general_chat",
      analysisKo:
        "같은 모델 패밀리가 이미 Tomverse 카탈로그에서 제공되고 있습니다. " +
        "별도 모델로 추가하기보다 기존 항목의 공급자·별칭 정보로 관리하는 편이 적절합니다.",
    };
  }
  if (input.availability === "unknown") {
    return {
      priority: "needs_evidence",
      kind: "general_chat",
      analysisKo:
        `${provider}의 최근 모델 API 확인이 실패했거나 실행 이력이 없습니다. ` +
        "현재 제공 여부를 확인하기 전에는 편입 여부를 결정하기 어렵습니다.",
    };
  }
  if (isMovingModelAlias(input.apiModel)) {
    return {
      priority: "review",
      kind: "moving_alias",
      analysisKo:
        `${provider}의 최신 모델 API에서 확인되는 이동형 별칭입니다. ` +
        "가리키는 버전이 바뀔 수 있으므로 고정 버전과 함께 한 패밀리로 검토해야 합니다.",
    };
  }
  if (isDatedModelSnapshot(input.apiModel)) {
    return {
      priority: "review",
      kind: "dated_snapshot",
      analysisKo:
        `${provider}의 최신 모델 API에서 확인되는 날짜·리비전 고정 스냅샷입니다. ` +
        "같은 패밀리의 안정 버전과 묶어 재현성 또는 호환성 필요가 있을 때만 편입할 가치가 있습니다.",
    };
  }
  if (isPreviewModel(input.apiModel)) {
    return {
      priority: "low",
      kind: "preview",
      analysisKo:
        `${provider}의 최신 모델 API에서 확인되지만 미리보기·실험 단계입니다. ` +
        "안정성·가격·지원 종료 조건을 확인한 뒤 제한적으로 검토하는 편이 안전합니다.",
    };
  }
  if (isCodeSpecializedModel(input.apiModel)) {
    return {
      priority: "low",
      kind: "specialized_code",
      analysisKo:
        `${provider}의 최신 모델 API에서 확인되는 코드 작업 특화 모델입니다. ` +
        "Tomverse Chat의 일반 대화 수요와 별개로 코딩 제품 범위가 확정될 때 편입 가치가 있습니다.",
    };
  }
  return {
    priority: "recommended",
    kind: "general_chat",
    analysisKo:
      `${provider}의 최신 모델 API에서 현재 확인되며 Tomverse가 아직 제공하지 않는 일반 대화 모델입니다. ` +
      "기존 모델 대비 품질·가격·컨텍스트 이점이 확인되면 편입 가치가 있습니다.",
  };
};
