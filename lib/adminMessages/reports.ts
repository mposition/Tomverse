import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the Operations report panel under Automation. */
export const adminReportsMessages = defineAdminMessages({
  en: {
    createFailed: "Could not create report.",
    created: "Operations report created and copied.",
    copied: "Report copied.",
    title: "Operations report",
    description:
      "Generate a compact weekly status report for users, paid accounts, feedback, refunds, alerts, and Stripe webhooks.",
    generate: "Generate report",
    copy: "Copy",
    empty: {
      title: "No report yet in this visit.",
      detail: "A generated report is copied to your clipboard and listed here until you leave the page.",
    },
    createdAt: (time: string) => `Created ${time}`,
  },
  ko: {
    createFailed: "보고서를 만들지 못했어요.",
    created: "운영 보고서를 만들고 복사했어요.",
    copied: "보고서를 복사했어요.",
    title: "운영 보고서",
    description:
      "사용자, 유료 계정, 피드백, 환불, 알림, Stripe webhook 현황을 담은 주간 보고서를 간단히 만들어 줘요.",
    generate: "보고서 만들기",
    copy: "복사",
    empty: {
      title: "이번 방문에는 만든 보고서가 없어요.",
      detail: "만든 보고서는 클립보드에 복사되고, 이 화면을 떠나기 전까지 여기에 남아요.",
    },
    createdAt: (time: string) => `${time} 생성`,
  },
});
