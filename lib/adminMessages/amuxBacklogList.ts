import { defineAdminMessages } from "@/lib/adminLocale";

export const adminAmuxBacklogListMessages = defineAdminMessages({
  en: {
    title: "Backlog cards", search: "Search card number", searchPlaceholder: "Card number or ID",
    clear: "Clear search", cardNumber: "Card number", createdAt: "Created",
    summary: "Summary", score: "Score", unscored: "Not scored", stale: "Needs refresh",
    summaryUnavailable: "Summary unavailable", summaryNotStored: "Summary not stored", empty: "No backlog cards.",
    noMatches: "No matching card number.", invalidSearch: "Use up to 128 letters, numbers or hyphens.",
    shown: (shown: number, total: number) => `${shown} of ${total} cards`,
    page: (page: number, total: number) => `Page ${page} of ${total}`,
    previous: "Previous page", next: "Next page",
    reauthenticate: "Sign in again to view card summaries.", signIn: "Sign in again",
  },
  ko: {
    title: "백로그 목록", search: "카드번호 검색", searchPlaceholder: "카드번호 또는 ID",
    clear: "검색 초기화", cardNumber: "카드번호", createdAt: "생성일",
    summary: "한줄 설명", score: "점수", unscored: "미평가", stale: "갱신 필요",
    summaryUnavailable: "설명 조회 불가", summaryNotStored: "설명 미저장", empty: "백로그 카드가 없습니다.",
    noMatches: "일치하는 카드번호가 없습니다.", invalidSearch: "영문, 숫자, 하이픈으로 128자 이내 입력하세요.",
    shown: (shown: number, total: number) => `전체 ${total}장 중 ${shown}장`,
    page: (page: number, total: number) => `${page} / ${total} 페이지`,
    previous: "이전 페이지", next: "다음 페이지",
    reauthenticate: "카드 설명을 보려면 최근 관리자 인증이 필요합니다.", signIn: "다시 로그인",
  },
});
