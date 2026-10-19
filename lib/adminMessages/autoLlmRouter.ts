import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the Auto LLM router control on Admin › Routing. */
export const adminAutoLlmRouterMessages = defineAdminMessages({
  en: {
    title: "Auto per-prompt model choice",
    description:
      "A small model reads each Auto message and picks the answering model from the candidates that passed plan, credit, context and health checks. Every decision is kept as training data for an in-house triage. Off keeps the cheapest-eligible rule.",
    label: "Router model",
    off: "Off (rule only)",
    save: "Save",
    saving: "Saving...",
    saved: "Saved.",
    loadFailed: "Could not load the setting.",
    saveFailed: "Could not save the setting.",
    costNote: "Each Auto turn adds one small provider request, paid from the provider budget, not the user's credits.",
  },
  ko: {
    title: "Auto 프롬프트별 모델 선택",
    description:
      "작은 모델이 Auto 메시지를 하나씩 읽고, 플랜·크레딧·context·장애 검사를 통과한 후보 중에서 답변 모델을 고릅니다. 모든 판정은 자체 Triage 학습 데이터로 저장됩니다. 끄면 가장 저렴한 후보를 고르는 기존 규칙만 씁니다.",
    label: "라우터 모델",
    off: "끔 (규칙만 사용)",
    save: "저장",
    saving: "저장 중...",
    saved: "저장했습니다.",
    loadFailed: "설정을 불러오지 못했습니다.",
    saveFailed: "설정을 저장하지 못했습니다.",
    costNote: "Auto 턴마다 작은 provider 요청이 하나 추가되며, 사용자 크레딧이 아니라 provider 예산에서 나갑니다.",
  },
});
