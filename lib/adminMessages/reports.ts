import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the Operations report panel under Automation. */
export const adminReportsMessages = defineAdminMessages({
  en: {
    createFailed: "Could not create report.",
    created: "Operations report created and copied.",
    copied: "Report copied.",
    eyebrow: "Reports",
    title: "Operations report",
    description:
      "Generate a compact weekly status report for users, paid accounts, feedback, refunds, alerts, and Stripe webhooks.",
    generate: "Generate report",
    copy: "Copy",
  },
  ko: {
    createFailed: "보고서를 만들지 못했습니다.",
    created: "운영 보고서를 만들고 복사했습니다.",
    copied: "보고서를 복사했습니다.",
    eyebrow: "보고서",
    title: "운영 보고서",
    description:
      "사용자, 유료 계정, 피드백, 환불, 알림, Stripe webhook 현황을 담은 간결한 주간 보고서를 만듭니다.",
    generate: "보고서 생성",
    copy: "복사",
  },
});
