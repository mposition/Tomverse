import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for the account security controls on the customer detail.
 *
 * Validation errors, pending labels, success toasts and failure sentences come
 * from `lib/adminUserSecurityCore.ts` / `lib/adminApiOutcome.ts` and are not
 * part of this namespace.
 */
export const adminUserSecurityMessages = defineAdminMessages({
  en: {
    title: "Account security controls",
    lastLogin: (at: string, sessions: number) =>
      `Last login: ${at} · Active sessions: ${sessions}`,
    accountStatus: (status: string) => `Account ${status}`,
    aiRestricted: "AI restricted",
    aiAllowed: "AI allowed",
    deletionSchedule: (requestedAt: string, scheduledFor: string) =>
      `Deletion requested ${requestedAt} · scheduled for ${scheduledFor}`,
    suspension: (reason: string, until: string) => `Suspension: ${reason} · until ${until}`,
    aiRestriction: (reason: string, until: string) =>
      `AI restriction: ${reason} · until ${until}`,
    incidentNote: (note: string) => `Incident note: ${note}`,
    reason: {
      label: "Audit reason ",
      required: "(required)",
      hint: (min: number) =>
        `At least ${min} characters. Applies to every control below and is stored in the admin audit log.`,
    },
    note: {
      label: "Security incident note ",
      optional: "(optional)",
      hint: "Free-text context kept on the account. Leave out anything the audit log does not need.",
    },
    restore: {
      title: "Cancel scheduled deletion",
      description:
        "Restores the account to active and clears the deletion schedule. A control expiry does not apply here, and automatic subscription renewal is not switched back on.",
      ticketLabel: "Support ticket reference ",
      ticketRequired: "(required to restore)",
      ticketHint: (min: number) =>
        `At least ${min} characters. Links this restoration to the customer request that authorised it.`,
      action: "Cancel deletion & restore account",
    },
    restrictions: {
      title: "Access restrictions",
      expiryLabel: "Control expiry ",
      expiryOptional: "(optional)",
      expiryHint: {
        before: "Applies only to ",
        suspend: "Suspend account",
        between: " and ",
        restrict: "Restrict AI usage",
        after:
          ". The restriction lifts automatically at this time. Entered in this browser's local time. It is not sent for session revocation, unlinking a login, or cancelling a scheduled deletion.",
      },
      unsuspend: "Unsuspend account",
      suspend: "Suspend account",
      restoreAi: "Restore AI usage",
      restrictAi: "Restrict AI usage",
      revokeSessions: "Revoke all sessions",
    },
    status: {
      calmTitle: "No restrictions right now",
      restrictedTitle: "This account has restrictions",
    },
    actions: {
      title: "What you can do",
      description:
        "Every action needs a reason, goes into the audit log and asks for a recent sign-in.",
    },
    cards: {
      ai: {
        title: "Restrict AI use",
        description: "They can still sign in and read chats, but new answers are blocked.",
        restoreTitle: "Restore AI use",
        restoreDescription: "New answers work again.",
      },
      suspend: {
        title: "Suspend account",
        description: "They cannot sign in. Their subscription payment carries on.",
        liftTitle: "Lift the suspension",
        liftDescription: "They can sign in again.",
      },
      sessions: {
        title: "Sign out of every device",
        description: "All devices are signed out. They can sign back in right away.",
      },
      unlink: {
        title: "Unlink a sign-in method",
        description: "They can no longer sign in with that provider. Owner only.",
      },
      delete: {
        title: "Delete account",
        description: "Removes the account and everything it owns for good. A second administrator has to approve it.",
        detail:
          "This cannot be undone once approved. Type the confirmation text on the next step; the request waits for a second administrator.",
      },
    },
    unlinkLabel: "Unlink OAuth (owner, audited):",
    unlink: (provider: string) => `Unlink ${provider}`,
    reauthenticate: "Sign in again to continue",
    footer:
      "High-risk controls require a recent administrator login. Sign in again if the console requests reauthentication.",
  },
  ko: {
    title: "계정 보안 제어",
    lastLogin: (at: string, sessions: number) =>
      `마지막 로그인: ${at} · 활성 세션: ${sessions}`,
    accountStatus: (status: string) => `계정 ${status}`,
    aiRestricted: "AI 제한됨",
    aiAllowed: "AI 허용됨",
    deletionSchedule: (requestedAt: string, scheduledFor: string) =>
      `삭제 요청 ${requestedAt} · 삭제 예정 ${scheduledFor}`,
    suspension: (reason: string, until: string) => `정지: ${reason} · 종료 ${until}`,
    aiRestriction: (reason: string, until: string) =>
      `AI 제한: ${reason} · 종료 ${until}`,
    incidentNote: (note: string) => `사고 메모: ${note}`,
    reason: {
      label: "감사 사유 ",
      required: "(필수)",
      hint: (min: number) =>
        `${min}자 이상 입력하세요. 아래 모든 제어에 적용되며 관리자 감사 로그에 저장됩니다.`,
    },
    note: {
      label: "보안 사고 메모 ",
      optional: "(선택)",
      hint: "계정에 보관되는 자유 형식 메모입니다. 감사 로그에 필요 없는 내용은 적지 마세요.",
    },
    restore: {
      title: "예약된 삭제 취소",
      description:
        "계정을 활성 상태로 되돌리고 삭제 일정을 지웁니다. 제어 만료 시각은 여기에 적용되지 않으며, 구독 자동 갱신은 다시 켜지지 않습니다.",
      ticketLabel: "고객 지원 티켓 번호 ",
      ticketRequired: "(복구 시 필수)",
      ticketHint: (min: number) =>
        `${min}자 이상 입력하세요. 이 복구를 승인한 고객 요청과 연결합니다.`,
      action: "삭제 취소 및 계정 복구",
    },
    restrictions: {
      title: "접근 제한",
      expiryLabel: "제어 만료 시각 ",
      expiryOptional: "(선택)",
      expiryHint: {
        before: "이 값은 ",
        suspend: "계정 정지",
        between: "와 ",
        restrict: "AI 사용 제한",
        after:
          "에만 적용되며, 이 시각에 제한이 자동으로 해제됩니다. 이 브라우저의 현지 시간으로 입력합니다. 세션 폐기, 로그인 연결 해제, 예약된 삭제 취소에는 전송되지 않습니다.",
      },
      unsuspend: "계정 정지 해제",
      suspend: "계정 정지",
      restoreAi: "AI 사용 복구",
      restrictAi: "AI 사용 제한",
      revokeSessions: "모든 세션 폐기",
    },
    status: {
      calmTitle: "지금은 아무 제한이 없어요",
      restrictedTitle: "이 계정에는 제한이 걸려 있어요",
    },
    actions: {
      title: "할 수 있는 조치",
      description: "모든 조치는 사유와 함께 감사 기록에 남고, 다시 인증이 필요해요.",
    },
    cards: {
      ai: {
        title: "AI 사용 제한",
        description: "로그인과 대화 보기는 되지만 새 답변은 받지 못해요.",
        restoreTitle: "AI 사용 되돌리기",
        restoreDescription: "새 답변을 다시 받을 수 있어요.",
      },
      suspend: {
        title: "계정 정지",
        description: "로그인할 수 없어요. 구독 결제는 그대로 유지돼요.",
        liftTitle: "정지 풀기",
        liftDescription: "다시 로그인할 수 있어요.",
      },
      sessions: {
        title: "모든 세션 끊기",
        description: "모든 기기에서 로그아웃돼요. 다시 로그인하면 바로 쓸 수 있어요.",
      },
      unlink: {
        title: "로그인 연결 해제",
        description: "그 로그인 방법으로는 더 이상 들어올 수 없어요. owner만 할 수 있어요.",
      },
      delete: {
        title: "계정 삭제",
        description: "계정과 소유한 모든 데이터를 영구 삭제해요. 다른 관리자의 승인이 필요해요.",
        detail:
          "승인되면 되돌릴 수 없어요. 다음 단계에서 확인 문구를 입력하면 요청이 다른 관리자의 승인을 기다려요.",
      },
    },
    unlinkLabel: "OAuth 연결 해제 (owner, 감사 로그에 기록):",
    unlink: (provider: string) => `${provider} 연결 해제`,
    reauthenticate: "계속하려면 다시 로그인",
    footer:
      "고위험 제어에는 최근 관리자 로그인이 필요합니다. 콘솔이 재인증을 요청하면 다시 로그인하세요.",
  },
});
