import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the provider pages: /admin/providers and /admin/providers/[provider]. */
export const adminProvidersPageMessages = defineAdminMessages({
  en: {
    healthTitle: "Provider health",
    healthDescription:
      "Status, key configuration, spend, fallback notes, and per-model metrics.",
    legend: {
      available: "Available",
      limited: "Limited",
      outage: "Outage",
      key: "Key",
    },
    detail: {
      eyebrow: "Provider workspace",
      description:
        "Summary, usage diagnostics, billing profile, credit checkpoint, recent errors, fallback policy, and manual operations.",
    },
  },
  ko: {
    healthTitle: "공급자 상태",
    healthDescription: "상태, key 설정, 지출, fallback 메모, 모델별 지표.",
    legend: {
      available: "사용 가능",
      limited: "제한됨",
      outage: "장애",
      key: "Key",
    },
    detail: {
      eyebrow: "공급자 작업 공간",
      description:
        "요약, 사용량 진단, 결제 프로필, 크레딧 checkpoint, 최근 오류, fallback 정책, 수동 운영.",
    },
  },
});
