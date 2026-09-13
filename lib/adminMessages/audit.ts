import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the audit workspace (`AdminAuditPanel`). */
export const adminAuditMessages = defineAdminMessages({
  en: {
    eyebrow: "Audit",
    title: "Admin activity log",
    description:
      "Search sensitive operational actions, copy incident context, and review billing or user-impacting changes from the console.",
    rowLimit: (limit: number) =>
      ` The ${limit} most recent entries; filters below search within them.`,
    requestedEntry: "Entry from the link",
    openFullEntry: "Open the full entry",
    missingEntryBefore: "No audit entry has the id",
    missingEntryAfter:
      ". The link may be stale, or the entry may belong to a different environment.",
    unknownAdmin: "Unknown admin",
    events: "Events",
    actors: "Actors",
    highRisk: "High risk",
    exportCsv: "Export CSV",
    searchPlaceholder: "Search actor, action, target, summary, IP...",
    allTargets: "All targets",
    columns: {
      time: "Time",
      actor: "Actor",
      action: "Action",
      target: "Target",
      summary: "Summary",
      context: "Context",
    },
    copy: "Copy",
    details: "Details",
    noMatches: "No audit events match the current filters.",
    footer:
      "Keep this log reviewed after billing, refund, or user deletion changes. It is intended for operational investigation, not customer-facing disclosure.",
    detail: {
      eyebrow: "Audit detail",
      target: "Target",
      request: "Request",
      summary: "Summary",
      metadata: "Metadata",
    },
    toast: {
      copied: "Audit event copied.",
      copyFailed: "Could not copy audit event.",
      detailFailed: "Could not load audit detail.",
    },
  },
  ko: {
    eyebrow: "감사",
    title: "관리자 활동 로그",
    description:
      "민감한 운영 작업을 검색하고, 인시던트 맥락을 복사하고, 결제나 사용자에게 영향을 주는 변경을 콘솔에서 검토합니다.",
    rowLimit: (limit: number) =>
      ` 최근 ${limit}건만 표시하며, 아래 필터는 이 범위 안에서만 검색합니다.`,
    requestedEntry: "링크로 지정된 항목",
    openFullEntry: "전체 항목 열기",
    missingEntryBefore: "다음 ID를 가진 감사 항목이 없습니다:",
    missingEntryAfter:
      ". 링크가 오래되었거나 다른 환경의 항목일 수 있습니다.",
    unknownAdmin: "알 수 없는 관리자",
    events: "이벤트",
    actors: "수행자",
    highRisk: "고위험",
    exportCsv: "CSV 내보내기",
    searchPlaceholder: "수행자, 작업, 대상, 요약, IP 검색...",
    allTargets: "모든 대상",
    columns: {
      time: "시각",
      actor: "수행자",
      action: "작업",
      target: "대상",
      summary: "요약",
      context: "컨텍스트",
    },
    copy: "복사",
    details: "상세",
    noMatches: "현재 필터와 일치하는 감사 이벤트가 없습니다.",
    footer:
      "결제, 환불, 사용자 삭제 변경 후에는 이 로그를 검토하세요. 운영 조사용이며 고객에게 공개하기 위한 것이 아닙니다.",
    detail: {
      eyebrow: "감사 상세",
      target: "대상",
      request: "요청",
      summary: "요약",
      metadata: "메타데이터",
    },
    toast: {
      copied: "감사 이벤트를 복사했습니다.",
      copyFailed: "감사 이벤트를 복사하지 못했습니다.",
      detailFailed: "감사 상세를 불러오지 못했습니다.",
    },
  },
});
