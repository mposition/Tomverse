import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the Alert policy panel under Alerts. */
export const adminAlertPolicyMessages = defineAdminMessages({
  en: {
    loadFailed: "Could not load alert policies.",
    saveFailed: "Could not save alert policy.",
    saved: "Alert policy saved.",
    eyebrow: "Alert policy",
    title: "Budget and incident thresholds",
    description:
      "Configure the operational thresholds used by provider budget, failure surge, and model incident alerts.",
    loading: "Loading alert policy...",
    name: "Name",
    budgetPercent: "Budget %",
    providerFail: "Provider fail",
    modelFail: "Model fail",
    email: "Email",
    save: "Save",
    allProviders: "all providers",
    appliesTo: (target: string) => `Applies to ${target}.`,
  },
  ko: {
    loadFailed: "알림 정책을 불러오지 못했습니다.",
    saveFailed: "알림 정책을 저장하지 못했습니다.",
    saved: "알림 정책을 저장했습니다.",
    eyebrow: "알림 정책",
    title: "예산 및 장애 임계값",
    description:
      "공급자 예산, 실패 급증, 모델 장애 알림에 쓰이는 운영 임계값을 설정합니다.",
    loading: "알림 정책을 불러오는 중...",
    name: "이름",
    budgetPercent: "예산 %",
    providerFail: "공급자 실패",
    modelFail: "모델 실패",
    email: "이메일",
    save: "저장",
    allProviders: "모든 공급자",
    appliesTo: (target: string) => `${target}에 적용됩니다.`,
  },
});
