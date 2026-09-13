import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the model registry panel on /admin/models?tab=registry. */
export const adminModelRegistryMessages = defineAdminMessages({
  en: {
    toast: {
      loadFailed: "Failed to load model registry.",
      adoptionDraftFailed: "Failed to load the adoption draft.",
      validationFailed: "Configuration validation failed.",
      validationPassed: "Model configuration is structurally valid.",
      saveFailed: "Failed to save model.",
      addedAndAdopted: "Model added, and its discovery item moved to validation.",
      added: "Model added to the DB registry.",
      updated: "Model registry updated.",
      archiveConfirm: (name: string) =>
        `Remove ${name} from the active catalogue? Historical conversations will remain readable.`,
      archiveFailed: "Failed to archive model.",
      archived: "Model removed from the active catalogue.",
    },
    header: {
      eyebrow: "DB Model Registry",
      title: "Model catalogue and API configuration",
      description:
        "Add and edit model identity, plan access, credits, capabilities, context, and token prices without a code deployment. Provider endpoints and API-key environment names are fixed in server code and cannot be changed from this console.",
      reload: "Reload",
      addModel: "Add model",
    },
    security: {
      title: "Blocked model-registry connection overrides detected",
      detail: (count: number) =>
        `${count} stored value${count === 1 ? "" : "s"} do not match the server allowlist. These entries are excluded from runtime use. Apply the security migration and rotate any secret that may have been exposed.`,
    },
    filters: {
      searchLabel: "Search models",
      searchPlaceholder: "Search name, model ID, API ID, provider, or purpose",
      provider: "Provider",
      allProviders: "All providers",
      lifecycle: "Lifecycle",
      clear: "Clear filters",
    },
    lifecycle: {
      labels: {
        operational: "Operational",
        active: "Active",
        limited: "Limited",
        "coming-soon": "Coming soon",
        disabled: "Disabled",
        retired: "Retired",
        archived: "Archived",
        all: "All models",
      },
      resultSummary: (shown: number, total: number) =>
        `Showing ${shown} of ${total} model${total === 1 ? "" : "s"}`,
      hiddenNote: (count: number, viewLabel: string) =>
        `${count} model${count === 1 ? " is" : "s are"} outside the ${viewLabel} view.`,
      emptyAll: "No models match the current search and provider filters.",
      emptyInView: (viewLabel: string) =>
        `No ${viewLabel.toLowerCase()} models match the current search and provider filters.`,
    },
    card: {
      credits: (credits: number) => `${credits} credits`,
      internalPrefix: "Internal: ",
      duplicateLabel: (name: string) => `Duplicate ${name}`,
      duplicateTitle: "Duplicate as a new disabled model",
      copy: "Copy",
      editLabel: (name: string) => `Edit ${name}`,
    },
    dialog: {
      addModel: "Add model",
      editModel: (name: string) => `Edit ${name}`,
      eyebrowAdopt: "Adopt discovered model",
      eyebrowDuplicate: "Duplicate registry entry",
      eyebrowNew: "New registry entry",
      eyebrowEdit: "Edit registry entry",
      untitled: "Untitled model",
      copiedFrom: (sourceId: string) =>
        `Copied from ${sourceId}. Confirm the new Registry ID and Provider API model ID before enabling it.`,
      adoptPrefilled:
        "Prefilled from the provider catalogue. Saving also moves this discovery item to validation.",
    },
    adopt: {
      unknownsTitle: "Values a person still has to decide",
      notesTitle: "Values already decided — leave them as they are",
      profileLookupFailed:
        "Could not confirm price inheritance. The server judges the save again.",
      reason: "Adoption reason (required)",
      reasonPlaceholder:
        "Why this model is being adopted now — kept in the approval record",
      classRequired:
        "Choose the sale class yourself before saving — the default is a value nobody decided.",
      reasoningSuggested:
        "Proposed from the provider's data, not read from it — confirm it before saving.",
      confirmReasoning: "Confirm this value",
      blankRequired: "Required · a blank does not save",
      blankSavesAs: (value: string) => `${value} · applied when blank`,
      priceFromDocs:
        "Prices were filled from the provider's documentation. Compare them with the source documents named above before confirming — a temporary price cannot always be recognised from its wording.",
      confirmPrice: "Checked against the source",
      draftNeedsId: "Enter a Registry ID to load the draft again.",
      draftFailed:
        "Could not load the draft for the chosen provider, model and ID. Check the provider's values and enter them yourself.",
      draftReloading: "Loading the draft again for the chosen provider, model and ID.",
      profileProposalTitle: "lib/modelPricing.ts profile proposal — review, then register it in a PR",
      copyProposal: "Copy",
      proposalCopied: "Copied the profile proposal.",
      proposalCopyFailed: "Could not copy. Select the text and copy it yourself.",
    },
    floor: {
      title: "Credit floor from base token prices",
      worstTurn: (inputTokens: string, outputTokens: string) =>
        `Worst accepted turn — ${inputTokens} input tokens plus a full ${outputTokens}-token answer — costs`,
      cacheWritePremium: " (input at the prompt-cache write premium)",
      cheapestClass: ". The cheapest class that covers it is",
      classCreditsJoin: " at",
      creditsLowerBound: " credits — a lower bound, not a price.",
      inheritedProfile:
        "Priced from this model's pricing profile, at the tier a prompt that size lands in, with the price columns left empty so the profile keeps applying.",
      notIncluded:
        "Native search per query, long-context price tiers and separately billed reasoning tokens are not in this figure, so a model carrying any of them needs more.",
      noClassBefore: "No usage class covers this price: the worst accepted turn costs",
      noClassAfter: ". Either the credit ceiling moves, or this model waits.",
      outputCapUnknown: "Set the maximum output tokens to compute the floor.",
      pricesUnknown: "Enter the provider's input and output prices to compute the floor.",
    },
    identity: {
      legend: "Identity and provider API",
      registryId: "Registry ID",
      displayName: "Display name",
      provider: "Provider",
      apiModel: "Provider API model ID",
      apiModelPlaceholder: "Exact model ID sent to provider",
      connectionTitle: "Server-enforced provider connection",
      connectionNote:
        "These values are allowlisted in server code. Model registry requests cannot override the destination or select another server secret.",
      icon: "Icon / short mark",
      purpose: "Model-specific purpose",
      purposePlaceholder: "One concise line shown in the model picker",
    },
    catalogue: {
      legend: "Catalogue, access, and credits",
      minimumPlan: "Minimum plan",
      usageClass: "Internal usage class",
      creditWeight: "Base credit weight",
      runtimeStatus: "Runtime status",
      status: {
        enabled: "Enabled",
        limited: "Limited",
        disabled: "Disabled",
        comingSoon: "Coming soon",
      },
      publiclyListed: "Publicly listed",
      replacementModel: "Replacement model",
      none: "None",
      sortOrder: "Sort order",
      operationalReason: "Internal operational reason",
      operationalReasonPlaceholder: "Visible only to administrators",
      userVisibleNote: "User-visible status note",
      userVisibleNotePlaceholder:
        "Safe explanation shown when this model is limited or unavailable",
    },
    capabilities: {
      legend: "Capabilities and context",
      imageInput: "Image input",
      nativePdf: "Native PDF",
      reasoning: "Reasoning",
      reasoningLevels: {
        none: "None",
        low: "Low",
        medium: "Medium",
        high: "High",
      },
      contextWindow: "Context window",
      maxImages: "Max images",
      maxBase64ImageBytes: "Max base64 image bytes",
    },
    tokens: {
      legend: "Token limits and cost snapshot (USD per 1M tokens)",
      maxOutputTokens: "Max output tokens",
      reservationOutputTokens: "Reservation output tokens",
      cachedInputMultiplier: "Cached input multiplier",
      inputUsd: "Input USD / 1M",
      outputUsd: "Output USD / 1M",
    },
    validation: {
      title: "Configuration check",
      summary: (protocol: string, apiKeyEnvName: string, keyState: string) =>
        `Protocol: ${protocol} · Key: ${apiKeyEnvName} (${keyState})`,
      configured: "configured",
      missing: "missing",
    },
    actions: {
      removeFromCatalogue: "Remove from catalogue",
      validate: "Validate",
      restoreAndSave: "Restore and save",
      saveModel: "Save model",
    },
  },
  ko: {
    toast: {
      loadFailed: "모델 레지스트리를 불러오지 못했습니다.",
      adoptionDraftFailed: "채택 초안을 불러오지 못했습니다.",
      validationFailed: "구성 검증에 실패했습니다.",
      validationPassed: "모델 구성이 구조적으로 유효합니다.",
      saveFailed: "모델을 저장하지 못했습니다.",
      addedAndAdopted: "모델을 추가했고, 발견 항목을 검증 단계로 옮겼습니다.",
      added: "DB 레지스트리에 모델을 추가했습니다.",
      updated: "모델 레지스트리를 업데이트했습니다.",
      archiveConfirm: (name: string) =>
        `${name}을(를) 활성 카탈로그에서 제거할까요? 과거 대화는 계속 읽을 수 있습니다.`,
      archiveFailed: "모델을 보관 처리하지 못했습니다.",
      archived: "활성 카탈로그에서 모델을 제거했습니다.",
    },
    header: {
      eyebrow: "DB 모델 레지스트리",
      title: "모델 카탈로그와 API 구성",
      description:
        "코드 배포 없이 모델 식별 정보, 플랜 접근, 크레딧, 기능, 컨텍스트, 토큰 가격을 추가·편집합니다. 공급자 endpoint와 API key 환경변수 이름은 서버 코드에 고정되어 있어 이 콘솔에서 바꿀 수 없습니다.",
      reload: "다시 불러오기",
      addModel: "모델 추가",
    },
    security: {
      title: "차단된 모델 레지스트리 연결 override가 감지되었습니다",
      detail: (count: number) =>
        `저장된 값 ${count}개가 서버 allowlist와 일치하지 않습니다. 이 항목은 런타임 사용에서 제외됩니다. 보안 migration을 적용하고, 노출되었을 수 있는 secret은 교체하세요.`,
    },
    filters: {
      searchLabel: "모델 검색",
      searchPlaceholder: "이름, 모델 ID, API ID, 공급자, 용도로 검색",
      provider: "공급자",
      allProviders: "모든 공급자",
      lifecycle: "수명주기",
      clear: "필터 초기화",
    },
    lifecycle: {
      labels: {
        operational: "운영 중",
        active: "활성",
        limited: "제한",
        "coming-soon": "출시 예정",
        disabled: "비활성",
        retired: "은퇴",
        archived: "보관됨",
        all: "모든 모델",
      },
      resultSummary: (shown: number, total: number) =>
        `모델 ${total}개 중 ${shown}개 표시`,
      hiddenNote: (count: number, viewLabel: string) =>
        `모델 ${count}개가 '${viewLabel}' 보기 밖에 있습니다.`,
      emptyAll: "현재 검색·공급자 필터와 일치하는 모델이 없습니다.",
      emptyInView: (viewLabel: string) =>
        `현재 검색·공급자 필터와 일치하는 '${viewLabel}' 모델이 없습니다.`,
    },
    card: {
      credits: (credits: number) => `${credits}크레딧`,
      internalPrefix: "내부: ",
      duplicateLabel: (name: string) => `${name} 복제`,
      duplicateTitle: "비활성 상태의 새 모델로 복제",
      copy: "복제",
      editLabel: (name: string) => `${name} 편집`,
    },
    dialog: {
      addModel: "모델 추가",
      editModel: (name: string) => `${name} 편집`,
      eyebrowAdopt: "발견된 모델 채택",
      eyebrowDuplicate: "레지스트리 항목 복제",
      eyebrowNew: "새 레지스트리 항목",
      eyebrowEdit: "레지스트리 항목 편집",
      untitled: "이름 없는 모델",
      copiedFrom: (sourceId: string) =>
        `${sourceId}에서 복제했습니다. 활성화하기 전에 새 Registry ID와 공급자 API 모델 ID를 확인하세요.`,
      adoptPrefilled:
        "공급자 카탈로그에서 미리 채웠습니다. 저장하면 이 발견 항목도 검증 단계로 옮겨집니다.",
    },
    adopt: {
      unknownsTitle: "아직 사람이 정해야 하는 값",
      notesTitle: "이미 정해진 값 — 그대로 두세요",
      profileLookupFailed:
        "가격 상속 확인에 실패했습니다. 저장은 서버가 다시 판정합니다.",
      reason: "채택 사유 (필수)",
      reasonPlaceholder: "왜 지금 이 모델을 편입하는지 — 승인 기록에 남습니다",
      classRequired:
        "판매 등급을 직접 선택해야 저장됩니다 — 기본값은 아무도 정하지 않은 값입니다.",
      reasoningSuggested: "공급자 정보로 제안한 값입니다 — 확정해야 저장됩니다.",
      confirmReasoning: "이 값으로 확정",
      blankRequired: "필수 · 비우면 저장되지 않습니다",
      blankSavesAs: (value: string) => `${value} · 비워 두면 적용`,
      priceFromDocs:
        "가격이 공급자 문서에서 채워졌습니다. 위 안내의 출처 문서와 대조한 뒤 확정해야 저장됩니다 — 임시 가격은 문구로 항상 알아볼 수 있지 않습니다.",
      confirmPrice: "출처와 대조했습니다",
      draftNeedsId: "Registry ID를 입력하면 초안을 다시 불러옵니다.",
      draftFailed:
        "선택한 공급자·모델·ID의 초안을 불러오지 못했습니다. 공급자가 제공한 값을 직접 확인해 입력하세요.",
      draftReloading: "선택한 공급자·모델·ID에 대한 초안을 다시 불러오는 중입니다.",
      profileProposalTitle: "lib/modelPricing.ts profile 제안 — 검토 후 PR로 등록",
      copyProposal: "복사",
      proposalCopied: "Profile 제안을 복사했습니다.",
      proposalCopyFailed: "복사하지 못했습니다. 직접 선택해 복사하세요.",
    },
    floor: {
      title: "기본 토큰 가격 기준 크레딧 하한",
      worstTurn: (inputTokens: string, outputTokens: string) =>
        `허용되는 최악의 turn(입력 ${inputTokens}토큰 + ${outputTokens}토큰을 모두 쓴 답변)의 비용은`,
      cacheWritePremium: " (입력은 prompt cache write premium 기준)",
      cheapestClass: "입니다. 이를 충당하는 가장 낮은 등급은",
      classCreditsJoin: ",",
      creditsLowerBound: "크레딧입니다 — 가격이 아니라 하한입니다.",
      inheritedProfile:
        "이 모델의 가격 profile에서, 그 크기의 prompt가 속하는 tier 요율로 계산했습니다. 가격 컬럼은 비워 두어 profile이 계속 적용됩니다.",
      notIncluded:
        "쿼리당 native 검색 요금, 장문 컨텍스트 가격 tier, 별도 과금되는 reasoning 토큰은 이 수치에 포함되지 않습니다. 이 중 하나라도 있는 모델은 더 높아야 합니다.",
      noClassBefore: "이 가격을 충당하는 사용 등급이 없습니다. 허용되는 최악의 turn 비용은",
      noClassAfter: "입니다. 크레딧 상한을 올리거나, 이 모델은 대기해야 합니다.",
      outputCapUnknown: "하한을 계산하려면 최대 출력 토큰을 설정하세요.",
      pricesUnknown: "하한을 계산하려면 공급자의 입력·출력 가격을 입력하세요.",
    },
    identity: {
      legend: "식별 정보와 공급자 API",
      registryId: "Registry ID",
      displayName: "표시 이름",
      provider: "공급자",
      apiModel: "공급자 API 모델 ID",
      apiModelPlaceholder: "공급자에 그대로 전송되는 모델 ID",
      connectionTitle: "서버가 강제하는 공급자 연결",
      connectionNote:
        "이 값은 서버 코드의 allowlist에 있습니다. 모델 레지스트리 요청으로 목적지를 override하거나 다른 서버 secret을 선택할 수 없습니다.",
      icon: "아이콘 / 짧은 표식",
      purpose: "모델별 용도",
      purposePlaceholder: "모델 선택기에 표시되는 간결한 한 줄",
    },
    catalogue: {
      legend: "카탈로그, 접근, 크레딧",
      minimumPlan: "최소 플랜",
      usageClass: "내부 사용 등급",
      creditWeight: "기본 크레딧 가중치",
      runtimeStatus: "런타임 상태",
      status: {
        enabled: "활성",
        limited: "제한",
        disabled: "비활성",
        comingSoon: "출시 예정",
      },
      publiclyListed: "공개 목록에 표시",
      replacementModel: "대체 모델",
      none: "없음",
      sortOrder: "정렬 순서",
      operationalReason: "내부 운영 사유",
      operationalReasonPlaceholder: "관리자에게만 표시됩니다",
      userVisibleNote: "사용자에게 보이는 상태 안내",
      userVisibleNotePlaceholder: "이 모델이 제한되거나 사용할 수 없을 때 보여 줄 안전한 설명",
    },
    capabilities: {
      legend: "기능과 컨텍스트",
      imageInput: "이미지 입력",
      nativePdf: "Native PDF",
      reasoning: "Reasoning",
      reasoningLevels: {
        none: "없음",
        low: "낮음",
        medium: "중간",
        high: "높음",
      },
      contextWindow: "컨텍스트 윈도",
      maxImages: "최대 이미지 수",
      maxBase64ImageBytes: "최대 base64 이미지 바이트",
    },
    tokens: {
      legend: "토큰 한도와 비용 snapshot (1M 토큰당 USD)",
      maxOutputTokens: "최대 출력 토큰",
      reservationOutputTokens: "예약 출력 토큰",
      cachedInputMultiplier: "캐시 입력 배수",
      inputUsd: "입력 USD / 1M",
      outputUsd: "출력 USD / 1M",
    },
    validation: {
      title: "구성 점검",
      summary: (protocol: string, apiKeyEnvName: string, keyState: string) =>
        `프로토콜: ${protocol} · Key: ${apiKeyEnvName} (${keyState})`,
      configured: "설정됨",
      missing: "없음",
    },
    actions: {
      removeFromCatalogue: "카탈로그에서 제거",
      validate: "검증",
      restoreAndSave: "복원 후 저장",
      saveModel: "모델 저장",
    },
  },
});
