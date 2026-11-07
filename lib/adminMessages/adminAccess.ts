import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for `/admin/admin-access` and its administrators tab (`AdminAccessPanel`). */
export const adminAccessMessages = defineAdminMessages({
  en: {
    tabsLabel: "Admin access sections",
    title: "Least-privilege access",
    description:
      "Who can open the console and what they can change. An identity without a role can only look.",
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
    area: {
      users: "users",
      billing: "billing",
      aiOps: "AI and operations",
      support: "customer support",
    },
    card: {
      canDo: "What they can do",
      expiry: "Access expires",
      lastLogin: "Last sign-in",
      lastActivity: "Last activity",
      identityType: { email: "email", userId: "user id" },
      expired: "Expired",
      notAuthorized: "Not allowed",
    },
    capability: {
      everything: "Everything, including destructive actions",
      writes: (writes: string) => `Can change ${writes}`,
      writesAndReads: (writes: string, reads: string) => `Can change ${writes}; can view ${reads}`,
      readsOnly: (reads: string) => `Can only view ${reads}`,
      none: "Cannot use the console",
    },
    envNote:
      "Roles use ADMIN_OWNER_EMAILS, ADMIN_BILLING_EMAILS, ADMIN_OPS_EMAILS, ADMIN_SUPPORT_EMAILS and ADMIN_READONLY_EMAILS. Access expiry uses ADMIN_ACCESS_EXPIRY_JSON.",
    roleTableSummary: "what each role may do, and where roles are set",
    noAdministrators: "No administrator identities are configured.",
    noExpiry: "No expiry",
    never: "Never",
    accessDisabled: "Access disabled",
  },
  ko: {
    tabsLabel: "관리자 접근 섹션",
    title: "최소 권한 접근",
    description:
      "누가 콘솔에 들어올 수 있고 무엇을 바꿀 수 있는지 보여 줘요. 역할이 없는 계정은 볼 수만 있어요.",
    columns: {
      role: "역할",
      users: "사용자",
      billing: "결제",
      aiOps: "AI / 운영",
      support: "고객지원",
      destructive: "되돌릴 수 없는 작업",
    },
    level: {
      full: "전체",
      read: "읽기",
      write: "쓰기",
      no: "없음",
      allowed: "허용",
    },
    area: {
      users: "사용자",
      billing: "결제",
      aiOps: "AI와 운영",
      support: "고객지원",
    },
    card: {
      canDo: "할 수 있는 일",
      expiry: "권한 만료",
      lastLogin: "마지막 접속",
      lastActivity: "마지막 활동",
      identityType: { email: "이메일", userId: "사용자 ID" },
      expired: "만료됨",
      notAuthorized: "허용 안 됨",
    },
    capability: {
      everything: "모든 권한, 되돌릴 수 없는 작업 포함",
      writes: (writes: string) => `${writes} 바꾸기`,
      writesAndReads: (writes: string, reads: string) => `${writes} 바꾸기, ${reads} 보기`,
      readsOnly: (reads: string) => `${reads} 보기만`,
      none: "콘솔을 쓸 수 없어요",
    },
    envNote:
      "역할은 ADMIN_OWNER_EMAILS, ADMIN_BILLING_EMAILS, ADMIN_OPS_EMAILS, ADMIN_SUPPORT_EMAILS, ADMIN_READONLY_EMAILS로 정해요. 접근 만료는 ADMIN_ACCESS_EXPIRY_JSON을 써요.",
    roleTableSummary: "역할별로 할 수 있는 일과 역할을 정하는 곳",
    noAdministrators: "구성된 관리자 계정이 없어요.",
    noExpiry: "만료 없음",
    never: "기록 없음",
    accessDisabled: "접근 꺼짐",
  },
});
