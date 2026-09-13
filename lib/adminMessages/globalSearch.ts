import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the global search workspace. */
export const adminGlobalSearchMessages = defineAdminMessages({
  en: {
    failed: "Admin search failed.",
    eyebrow: "Global search",
    title: "Find customers, tickets, refunds, and audit events",
    description: "Search across the operational records operators use most often.",
    inputLabel: "Search records by email, Stripe ID, trace ID, refund or audit action",
    inputPlaceholder: "Search email, Stripe ID, trace ID, refund, audit action...",
    submit: "Search",
    empty: "Enter at least two characters to search Admin records.",
  },
  ko: {
    failed: "관리자 검색에 실패했습니다.",
    eyebrow: "전체 검색",
    title: "고객, 티켓, 환불, 감사 이벤트 찾기",
    description: "운영자가 가장 자주 쓰는 운영 레코드를 한 번에 검색합니다.",
    inputLabel: "이메일, Stripe ID, trace ID, 환불, 감사 작업으로 레코드 검색",
    inputPlaceholder: "이메일, Stripe ID, trace ID, 환불, 감사 작업 검색...",
    submit: "검색",
    empty: "관리자 레코드를 검색하려면 두 글자 이상 입력하세요.",
  },
});
