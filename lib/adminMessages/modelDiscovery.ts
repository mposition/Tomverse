import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the model discovery queue on /admin/models?tab=discovery. */
export const adminModelDiscoveryMessages = defineAdminMessages({
  en: {
    priority: {
      recommended: "Recommended review",
      review: "Family review",
      needs_evidence: "Needs evidence",
      low: "Low priority",
      no_action: "No action recommended",
    },
    availability: {
      current: "Current API confirmed",
      stale: "Current API unconfirmed",
      unknown: "Cannot confirm",
    },
    product: {
      chat: "Chat",
      image_generation: "Image generation",
      unsupported: "Unsupported product",
    },
    toast: {
      noApplicableItems: "No items in the selected groups can be applied.",
      tooManyItems: (max: number) => `You can process at most ${max} items at once.`,
      closeConfirm: (count: number) =>
        `Close ${count} items as 'No action'? This status cannot be undone.`,
      transitionRefused: "The queue refused that transition.",
      updated: (count: number) => `Updated ${count} items.`,
      unreachable: "The request did not reach the server.",
      validationPrompt: (validation: string) =>
        `Recording the '${validation}' validation as complete. Describe what you checked.`,
      validationFailed: "Could not record the validation.",
      validationRemaining: (validation: string, remaining: number) =>
        `'${validation}' complete. ${remaining} validations remaining.`,
      validationNoneRemaining: (validation: string) =>
        `'${validation}' complete. No validations remaining.`,
      bulkReasonRequired: "Enter a bulk review reason first.",
    },
    header: {
      title: "Awaiting review",
      loading: "loading",
      counts: (items: number, families: number) => `${items} items · ${families} families`,
      refreshing: "Refreshing",
      intro:
        "Shows the provider's latest model API evidence separately from the adoption value for each Tomverse product. Image models are reviewed as Studio candidates, and Google chat models are reviewed through to the Brave web search path. Dated versions and aliases are grouped into one family, and a recommendation is not an automatic decision.",
    },
    failed: "Could not read the queue. This does not mean the current list is up to date.",
    retry: "Try again",
    truncated:
      "Loaded only up to the safety limit of 1,000 items. Filter counts are based on the loaded items.",
    loadingBacklog: "Loading the backlog…",
    empty: "Nothing is waiting. Discovery runs daily at 10:00 Australia/Brisbane.",
    filters: {
      searchPlaceholder: "Search models, providers, analysis",
      searchLabel: "Search model review queue",
      priorityLabel: "Filter by review priority",
      allPriorities: (count: number) => `All priorities (${count})`,
      productLabel: "Filter by Tomverse product",
      allProducts: "All products",
      providerLabel: "Filter by provider",
      allProviders: "All providers",
      availabilityLabel: "Filter by provider availability",
      allAvailability: "All availability states",
      statusLabel: "Filter by workflow status",
      allStatuses: "All workflow statuses",
    },
    bulk: {
      reasonPlaceholder: "Bulk review reason (required, recorded on every selected item)",
      reasonLabel: "Bulk review reason",
      selected: (count: number) => `${count} families selected`,
    },
    transitions: {
      needsDecision: "Needs decision",
      notYet: "Not yet",
      noAction: "No action",
    },
    table: {
      selectPage: "Select all families on this page",
      modelFamily: "Model family",
      evidence: "Evidence",
      analysis: "Tomverse analysis",
      workflow: "Workflow",
      waiting: "Waiting",
      triage: "Triage",
      selectFamily: (key: string) => `Select ${key}`,
      relatedIds: (count: number) => `+${count} related IDs`,
      braveReview: "Brave web search review",
      supersededBy: (model: string) => `Later version in service: ${model}`,
      days: (days: number) => `${days}d`,
      recordValidationTitle: "Record this validation as complete",
      adopt: "Adopt",
      noMatches: "No model families match the current filters.",
    },
    pagination: {
      summary: (families: number, page: number, pageCount: number) =>
        `${families} families · page ${page} / ${pageCount}`,
      previous: "Previous",
      next: "Next",
    },
  },
  ko: {
    priority: {
      recommended: "권장 검토",
      review: "패밀리 검토",
      needs_evidence: "근거 확인 필요",
      low: "낮은 우선순위",
      no_action: "조치 비권장",
    },
    availability: {
      current: "최신 API 확인",
      stale: "최신 API 미확인",
      unknown: "확인 불가",
    },
    product: {
      chat: "Chat",
      image_generation: "이미지 생성",
      unsupported: "미지원 제품",
    },
    toast: {
      noApplicableItems: "선택한 그룹에 적용 가능한 항목이 없습니다.",
      tooManyItems: (max: number) => `한 번에 최대 ${max}개 항목까지 처리할 수 있습니다.`,
      closeConfirm: (count: number) =>
        `${count}개 항목을 '조치 없음'으로 종료할까요? 이 상태는 되돌릴 수 없습니다.`,
      transitionRefused: "대기열이 이 상태 전환을 거부했습니다.",
      updated: (count: number) => `${count}개 항목을 업데이트했습니다.`,
      unreachable: "요청이 서버에 도달하지 못했습니다.",
      validationPrompt: (validation: string) =>
        `'${validation}' 검증을 완료로 기록합니다. 무엇을 확인했는지 적어 주세요.`,
      validationFailed: "검증을 기록하지 못했습니다.",
      validationRemaining: (validation: string, remaining: number) =>
        `'${validation}' 완료. 남은 검증 ${remaining}건.`,
      validationNoneRemaining: (validation: string) =>
        `'${validation}' 완료. 남은 검증이 없습니다.`,
      bulkReasonRequired: "벌크 검토 사유를 먼저 입력해 주세요.",
    },
    header: {
      title: "검토 대기",
      loading: "불러오는 중",
      counts: (items: number, families: number) => `항목 ${items}건 · 패밀리 ${families}개`,
      refreshing: "새로고침 중",
      intro:
        "공급자의 최신 모델 API 증거와 Tomverse 제품별 편입 가치를 분리해 보여줍니다. 이미지 모델은 Studio 후보로, Google 채팅 모델은 Brave 웹검색 경로까지 검토합니다. 날짜별 버전과 별칭은 한 패밀리로 묶이며, 추천은 자동 결정이 아닙니다.",
    },
    failed: "큐를 읽지 못했습니다. 현재 목록이 최신이라는 뜻이 아닙니다.",
    retry: "다시 시도",
    truncated: "안전 한도인 1,000개까지만 불러왔습니다. 필터 집계는 로드된 항목 기준입니다.",
    loadingBacklog: "백로그를 불러오는 중…",
    empty: "대기 중인 항목이 없습니다. 발견 작업은 매일 10:00(Australia/Brisbane)에 실행됩니다.",
    filters: {
      searchPlaceholder: "모델·공급자·분석 검색",
      searchLabel: "모델 검토 대기열 검색",
      priorityLabel: "검토 우선순위로 필터",
      allPriorities: (count: number) => `모든 우선순위 (${count})`,
      productLabel: "Tomverse 제품으로 필터",
      allProducts: "모든 제품",
      providerLabel: "공급자로 필터",
      allProviders: "모든 공급자",
      availabilityLabel: "공급자 제공 상태로 필터",
      allAvailability: "모든 제공 상태",
      statusLabel: "워크플로 상태로 필터",
      allStatuses: "모든 워크플로 상태",
    },
    bulk: {
      reasonPlaceholder: "벌크 검토 사유 (필수, 선택 항목에 공통 기록)",
      reasonLabel: "벌크 검토 사유",
      selected: (count: number) => `패밀리 ${count}개 선택됨`,
    },
    transitions: {
      needsDecision: "결정 필요",
      notYet: "보류",
      noAction: "조치 없음",
    },
    table: {
      selectPage: "이 페이지의 모든 패밀리 선택",
      modelFamily: "모델 패밀리",
      evidence: "근거",
      analysis: "Tomverse 분석",
      workflow: "워크플로",
      waiting: "대기 기간",
      triage: "분류",
      selectFamily: (key: string) => `${key} 선택`,
      relatedIds: (count: number) => `관련 ID +${count}개`,
      braveReview: "Brave 웹검색 검토",
      supersededBy: (model: string) => `상위 버전 서비스 중: ${model}`,
      days: (days: number) => `${days}일`,
      recordValidationTitle: "이 검증을 완료로 기록합니다",
      adopt: "채택",
      noMatches: "현재 필터에 맞는 모델 패밀리가 없습니다.",
    },
    pagination: {
      summary: (families: number, page: number, pageCount: number) =>
        `패밀리 ${families}개 · ${page} / ${pageCount} 페이지`,
      previous: "이전",
      next: "다음",
    },
  },
});
