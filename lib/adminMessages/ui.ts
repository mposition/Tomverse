import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy shared by the console's UI primitives (`components/admin/ui/*`). */
export const adminUiMessages = defineAdminMessages({
  en: {
    // An unread value is never shown as zero or as healthy.
    unavailable: "Unavailable",
    unreadDetail: "Could not be read.",
    retry: "Try again",
    loading: "Loading",
    techInfo: "Technical details",
    close: "Close",
    cancel: "Cancel",
    writeLocked: (role: string) => `Needs ${role} access`,
    stepUpNote: "This needs a recent sign-in, and it is recorded in the audit log.",
    stepUpAction: (label: string) => `Sign in again and ${label.toLowerCase()}`,
    tone: {
      ok: "Healthy",
      warn: "Needs attention",
      bad: "Failed",
      info: "In progress",
      idle: "Off",
      unknown: "Unavailable",
    },
  },
  ko: {
    unavailable: "확인 불가",
    unreadDetail: "읽지 못했어요.",
    retry: "다시 시도",
    loading: "불러오는 중",
    techInfo: "기술 정보",
    close: "닫기",
    cancel: "취소",
    writeLocked: (role: string) => `${role} 권한이 필요해요`,
    stepUpNote: "최근 인증이 필요하고, 감사 기록에 남아요.",
    stepUpAction: (label: string) => `다시 인증하고 ${label}`,
    tone: {
      ok: "정상",
      warn: "주의",
      bad: "실패",
      info: "진행 중",
      idle: "꺼짐",
      unknown: "확인 불가",
    },
  },
});
