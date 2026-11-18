import { defineAdminMessages } from "@/lib/adminLocale";

export const adminDailyProductImplementationMessages = defineAdminMessages({
  en: {
    open: "Linked implementation PR open",
    merged: "Merged into develop · production deployment unconfirmed",
    closed: "PR closed without merge",
    unavailable: "Implementation PR status could not be checked.",
  },
  ko: {
    open: "연결된 구현 PR 열림",
    merged: "develop 병합 · 운영 반영 확인 필요",
    closed: "PR 닫힘 · 병합되지 않음",
    unavailable: "구현 PR 상태를 확인하지 못했습니다.",
  },
});
