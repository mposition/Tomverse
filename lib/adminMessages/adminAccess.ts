import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for `/admin/admin-access` and its administrators tab (`AdminAccessPanel`). */
export const adminAccessMessages = defineAdminMessages({
  en: {
    tabsLabel: "Admin access sections",
    roleMatrix: "Role matrix",
    title: "Least-privilege access",
    description:
      "Allowlisting grants Console access. An explicit role grants write permissions; identities without a role remain read-only.",
    columns: {
      role: "Role",
      users: "Users",
      billing: "Billing",
      aiOps: "AI / Ops",
      support: "Support",
      destructive: "Destructive",
    },
    level: {
      full: "Full",
      read: "Read",
      write: "Write",
      no: "No",
      allowed: "Allowed",
    },
    envNote:
      "Roles use ADMIN_OWNER_EMAILS, ADMIN_BILLING_EMAILS, ADMIN_OPS_EMAILS, ADMIN_SUPPORT_EMAILS and ADMIN_READONLY_EMAILS. Access expiry uses ADMIN_ACCESS_EXPIRY_JSON.",
    configuredAdministrators: "Configured administrators",
    noAdministrators: "No administrator identities are configured.",
    expires: (date: string) => `Expires ${date} UTC`,
    noExpiry: "No expiry",
    never: "Never",
    lastSeen: (login: string, activity: string) =>
      `Last login ${login} UTC · Last activity ${activity} UTC`,
    accessEnabled: "Access enabled",
    accessDisabled: "Access disabled",
  },
  ko: {
    tabsLabel: "관리자 접근 섹션",
    roleMatrix: "역할 매트릭스",
    title: "최소 권한 접근",
    description:
      "허용 목록에 등록되면 콘솔에 접근할 수 있습니다. 명시적 역할이 있어야 쓰기 권한이 부여되며, 역할이 없는 계정은 읽기 전용으로 남습니다.",
    columns: {
      role: "역할",
      users: "사용자",
      billing: "결제",
      aiOps: "AI / 운영",
      support: "고객지원",
      destructive: "파괴적 작업",
    },
    level: {
      full: "전체",
      read: "읽기",
      write: "쓰기",
      no: "없음",
      allowed: "허용",
    },
    envNote:
      "역할은 ADMIN_OWNER_EMAILS, ADMIN_BILLING_EMAILS, ADMIN_OPS_EMAILS, ADMIN_SUPPORT_EMAILS, ADMIN_READONLY_EMAILS로 정합니다. 접근 만료는 ADMIN_ACCESS_EXPIRY_JSON을 사용합니다.",
    configuredAdministrators: "구성된 관리자",
    noAdministrators: "구성된 관리자 계정이 없습니다.",
    expires: (date: string) => `만료 ${date} UTC`,
    noExpiry: "만료 없음",
    never: "기록 없음",
    lastSeen: (login: string, activity: string) =>
      `마지막 로그인 ${login} UTC · 마지막 활동 ${activity} UTC`,
    accessEnabled: "접근 활성",
    accessDisabled: "접근 비활성",
  },
});
