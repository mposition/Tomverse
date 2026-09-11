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
  "superseded_version",
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

/**
 * The date and revision suffixes a provider hangs off a model name.
 *
 * The last three entries are the reason a decision stopped being remembered.
 * Google writes the day *inside* the name -- `gemini-2.5-flash-preview-05-20`
 * -- and a list that only knew `-2026-05-20` left the `-05-20` in the identity,
 * so the next month's snapshot was a different family, had no decision against
 * it, and came back for review. Two digits are required on each side on
 * purpose: `claude-opus-4-6` must not read as the sixth of April.
 */
const DATED_SUFFIXES = [
  /-(?:20\d{2})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/,
  /-(?:20\d{6})$/,
  /-(?:0\d|1[0-2])(?:0\d|[12]\d|3[01])$/,
  /-(?:00[1-9]|0[1-9]\d)$/,
  /-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/,
  /-(?:0[1-9]|1[0-2])-20\d{2}$/,
  /-(?:20\d{2})-(?:0[1-9]|1[0-2])$/,
] as const;

const stripOneDatedSuffix = (value: string) => {
  for (const pattern of DATED_SUFFIXES) {
    if (pattern.test(value)) return value.replace(pattern, "");
  }
  return value;
};

/** The release-stage word a provider hangs off the end of a name. */
const STAGE_SUFFIX =
  /-(?:preview\d*|beta\d*|eap|early[-_.]?access|experimental|exp|alpha\d*|rc\d*|nightly|canary)$/;

const MOVING_ALIAS_SUFFIX = /(?:-|@)(?:latest|auto)$/;

export const isDatedModelSnapshot = (apiModel: string) => {
  const identity = modelIdentityWithoutVendor(apiModel);
  const withoutStage = identity.replace(STAGE_SUFFIX, "");
  return stripOneDatedSuffix(withoutStage) !== withoutStage;
};

export const isMovingModelAlias = (apiModel: string) =>
  MOVING_ALIAS_SUFFIX.test(modelIdentityWithoutVendor(apiModel));

/**
 * The words a provider uses for "this is not the finished thing".
 *
 * `exp` is here because leaving it out cost the policy its point: with only the
 * four long spellings, `gemini-3-pro-exp-02-05` and `deepseek-v3.2-exp` were
 * still queued for review every morning after prerelease models were supposed
 * to stop entering it.
 *
 * Three words a reader expects are deliberately absent. `dev` names a shipped
 * production weight (`FLUX.1-dev`), `draft` names the small companion model a
 * speculative-decoding setup actually serves, and `test` is a real word inside
 * model names that have nothing to do with release stage. Excluding a model
 * that a provider does serve is silent -- nothing says the candidate was
 * dropped -- so the list stays to the markers whose meaning is unambiguous.
 */
const PRERELEASE_MARKER =
  /(?:^|[-_.\s])(?:preview\d*|beta\d*|eap|early[-_.]?access|experimental|exp|alpha\d*|rc\d*|nightly|canary)(?:$|[-_.\s])/;

/** Models that a provider has not presented as a stable production release. */
export const isPrereleaseModel = (
  apiModel: string,
  releaseStage?: string | null
) =>
  PRERELEASE_MARKER.test(modelIdentityWithoutVendor(apiModel)) ||
  (typeof releaseStage === "string" &&
    PRERELEASE_MARKER.test(releaseStage.trim().toLowerCase()));

/** Kept for the triage kind and existing callers; it covers every prerelease marker. */
export const isPreviewModel = (apiModel: string) =>
  isPrereleaseModel(apiModel);

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
  // Until nothing changes, rather than a fixed number of passes. Providers
  // stack these in whatever order they like -- `-preview-05-20` puts the date
  // last, `-05-20-preview` puts the stage last, `-latest` can sit on top of
  // either -- and a fixed two rounds left whichever layer came third in the
  // identity. That residue is what made the same model a new family, and a new
  // family has no decision recorded against it.
  for (let pass = 0; pass < 6; pass += 1) {
    const before = identity;
    identity = identity.replace(MOVING_ALIAS_SUFFIX, "");
    identity = identity.replace(STAGE_SUFFIX, "");
    identity = stripOneDatedSuffix(identity);
    if (identity === before) break;
  }
  return identity;
};

/** Whether a provider is presenting this id as finished work. */
export const modelStage = (
  apiModel: string,
  releaseStage?: string | null
): "stable" | "prerelease" =>
  isPrereleaseModel(apiModel, releaseStage) ? "prerelease" : "stable";

/**
 * The key a decision about a model is remembered under.
 *
 * The family alone is not enough, and the difference matters in one direction
 * only. `candidateFamilyIdentity` deliberately folds a preview into the family
 * it previews, so "no action on the preview" and "no action on the release"
 * would be the same record -- and the release, when it finally shipped, would
 * be suppressed by a decision nobody made about it. Stage-qualifying the key
 * keeps those two apart; `decisionSuppressesCandidate` then says which way the
 * suppression runs.
 */
export const candidateDecisionKey = (
  apiModel: string,
  releaseStage?: string | null
) => `${candidateFamilyIdentity(apiModel)}@${modelStage(apiModel, releaseStage)}`;

/**
 * Whether a recorded decision covers a model seen today.
 *
 * A decision about the finished model covers its previews: nobody wants the
 * preview of something they have already declined. The reverse is not true --
 * declining a preview says nothing about the release.
 */
export const decisionSuppressesCandidate = (
  decisionKey: string,
  candidateApiModel: string,
  candidateReleaseStage?: string | null
) => {
  const [decidedFamily, decidedStage] = splitDecisionKey(decisionKey);
  if (decidedFamily !== candidateFamilyIdentity(candidateApiModel)) return false;
  if (decidedStage === "stable") return true;
  return modelStage(candidateApiModel, candidateReleaseStage) === "prerelease";
};

/** The family half of a decision key, for indexing decisions by model. */
export const decisionKeyFamily = (decisionKey: string) =>
  splitDecisionKey(decisionKey)[0];

const splitDecisionKey = (decisionKey: string): [string, string] => {
  const separator = decisionKey.lastIndexOf("@");
  // A key written before this scheme existed is a bare family identity. Read
  // as stable, so it keeps suppressing exactly what it suppressed before.
  if (separator < 0) return [decisionKey, "stable"];
  return [
    decisionKey.slice(0, separator),
    decisionKey.slice(separator + 1) || "stable",
  ];
};

/** A bare version number, with or without a `v`: `5`, `4`, `2.5`, `v3.2`. */
const VERSION_SEGMENT = /^v?(\d+(?:\.\d+)*)$/;
/** A version glued to the name it belongs to: `qwen3`, `o4`. */
const NAMED_VERSION_SEGMENT = /^([a-z]+)(\d+(?:\.\d+)*)$/;

const parseVersionParts = (value: string) =>
  value.split(".").map((part) => Number.parseInt(part, 10));

type ModelLine = { line: string; version: number[] | null };

/**
 * The product line an id belongs to, and which generation of it this is.
 *
 * Split rather than merged because only one half is a guess. The line is the
 * name with the generation removed and **the tier left in** -- `claude-opus`
 * and `claude-sonnet` are two lines, `gpt-mini` is not `gpt` -- and the version
 * is the number that orders one line's releases. An id this cannot read gets a
 * `null` version and is never superseded by anything, which is the whole point
 * of returning it rather than a boolean: a guessed version would retire a model
 * on the strength of a name we did not understand.
 */
export const modelLine = (apiModel: string): ModelLine => {
  const segments = candidateFamilyIdentity(apiModel).split("-").filter(Boolean);
  const lineSegments: string[] = [];
  let version: number[] | null = null;
  // Only bare integers that directly follow a bare integer continue a version:
  // `claude-opus-4-6` is 4.6, while `gemini-2.5-flash` stops at 2.5 and
  // `qwen3-max` stops at 3.
  let versionOpen = false;

  for (const segment of segments) {
    const bare = VERSION_SEGMENT.exec(segment);
    if (bare) {
      const parts = parseVersionParts(bare[1]);
      if (version === null) {
        version = parts;
        versionOpen = parts.length === 1 && !segment.includes(".");
        continue;
      }
      if (versionOpen && parts.length === 1) {
        version = [...version, ...parts];
        continue;
      }
      lineSegments.push(segment);
      versionOpen = false;
      continue;
    }
    versionOpen = false;
    const named = version === null ? NAMED_VERSION_SEGMENT.exec(segment) : null;
    if (named) {
      version = parseVersionParts(named[2]);
      lineSegments.push(named[1]);
      continue;
    }
    lineSegments.push(segment);
  }

  return { line: lineSegments.join("-"), version };
};

export const compareModelVersions = (
  left: readonly number[],
  right: readonly number[]
) => {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/**
 * The model already served that makes this candidate an older generation of
 * something Tomverse has, or `null`.
 *
 * Returns the id rather than a boolean because the operator has to be told
 * *which* model this was measured against -- "Opus 4.6 is behind Opus 5" is
 * checkable and "not recommended" is not.
 *
 * Equal versions count: a candidate that is the same generation of the same
 * line as a served model adds nothing, and the id it arrived under is already
 * handled by the family collapse above.
 */
export const supersedingServedModel = (
  candidateApiModel: string,
  servedApiModels: readonly string[]
): string | null => {
  const candidate = modelLine(candidateApiModel);
  if (!candidate.version || !candidate.line) return null;
  let best: { apiModel: string; version: number[] } | null = null;
  for (const servedApiModel of servedApiModels) {
    const served = modelLine(servedApiModel);
    if (!served.version || served.line !== candidate.line) continue;
    if (compareModelVersions(served.version, candidate.version) < 0) continue;
    if (best && compareModelVersions(served.version, best.version) <= 0) continue;
    best = { apiModel: servedApiModel, version: served.version };
  }
  return best?.apiModel ?? null;
};

/** The newest id per line, for collapsing one scan's own generations. */
export const newestByModelLine = <T>(
  items: readonly T[],
  apiModelOf: (item: T) => string
): T[] => {
  const byLine = new Map<string, { item: T; version: number[] }>();
  const keep = new Set<T>();
  for (const item of items) {
    const { line, version } = modelLine(apiModelOf(item));
    if (!version || !line) {
      // Unreadable is not the same as older. It stays.
      keep.add(item);
      continue;
    }
    const held = byLine.get(line);
    if (held && compareModelVersions(version, held.version) <= 0) continue;
    byLine.set(line, { item, version });
  }
  for (const entry of byLine.values()) keep.add(entry.item);
  return items.filter((item) => keep.has(item));
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

/** Only stable Chat and Image Studio candidates enter review. */
export const shouldQueueModelCandidate = (apiModel: string) =>
  modelProductSurface(apiModel) !== "unsupported" &&
  !isPrereleaseModel(apiModel);

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
  /**
   * The served model that is a later generation of this candidate's own line,
   * from `supersedingServedModel`. Named rather than flagged: an operator has
   * to be able to check the claim.
   */
  supersededBy?: string | null;
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
  // Ahead of the product branches because it is the same answer for both, and
  // ahead of `servedByTomverse` because it is the case that check cannot see:
  // Opus 4.6 is not the family Tomverse serves, it is the generation before it.
  if (input.supersededBy) {
    return {
      priority: "no_action",
      kind: "superseded_version",
      product,
      analysisKo:
        `같은 제품 라인에서 Tomverse가 이미 상위 버전 '${input.supersededBy}'을(를) 서비스하고 있습니다. ` +
        "하위 버전을 별도로 추가할 근거가 없어 편입 후보에서 제외합니다.",
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
        priority: "no_action",
        kind: "image_generation",
        product,
        analysisKo:
          `${provider}에서 확인되는 미리보기·실험 단계 이미지 생성 모델입니다. ` +
          "안정 버전만 검토하는 현재 정책에 따라 Studio 편입 후보에서 제외합니다.",
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
      priority: "no_action",
      kind: "preview",
      product,
      analysisKo:
        `${provider}의 최신 모델 API에서 확인되지만 미리보기·실험 단계입니다. ` +
        "안정 버전만 검토하는 현재 정책에 따라 모델 편입 후보에서 제외합니다." +
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
