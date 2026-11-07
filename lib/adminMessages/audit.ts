import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the audit workspace (`AdminAuditPanel`) and its integrity card. */
export const adminAuditMessages = defineAdminMessages({
  en: {
    title: "Admin activity log",
    description:
      "Everything an administrator changed is kept here, and the records are chained so none can be altered quietly.",
    rowLimit: (limit: number) =>
      ` The ${limit} most recent entries; filters below search within them.`,
    requestedEntry: "Entry from the link",
    openFullEntry: "Open the full entry",
    missingEntryBefore: "No audit entry has the id",
    missingEntryAfter:
      ". The link may be stale, or the entry may belong to a different environment.",
    unknownAdmin: "Unknown admin",
    summaryLine: (events: number, actors: number, highRisk: number) =>
      `${events} entries · ${actors} people · ${highRisk} high risk`,
    exportCsv: "Export CSV",
    searchPlaceholder: "Search actor, action, target, summary, IP...",
    searchLabel: "Search the audit log",
    allTargets: "All targets",
    allActors: "Everyone",
    targetFilter: "Target type",
    actorFilter: "Who",
    columns: {
      actor: "Who",
      action: "What",
      target: "Target",
      time: "When",
      context: "Details",
    },
    table: "Administrator activity",
    details: "Details",
    noMatches: "No audit events match the current filters.",
    footer:
      "Keep this log reviewed after billing, refund, or user deletion changes. It is meant for investigating operations, not for showing to customers.",
    detail: {
      title: "Audit entry",
      target: "Target",
      request: "Where it came from",
      summary: "What happened",
      who: "Who",
      when: "When",
      copy: "Copy",
      close: "Close",
      tech: "Request and metadata",
    },
    toast: {
      copied: "Audit event copied.",
      copyFailed: "Could not copy audit event.",
      detailFailed: "Could not load audit detail.",
    },
    integrityCard: {
      title: {
        idle: "The chain has not been checked yet",
        ok: "The record chain is intact",
        truncated: "The check stopped before the newest records",
        bad: "The record chain has a problem",
        failed: "The check could not run",
      },
      detail: {
        idle: "Press Check now to read every record from the first one and confirm none was changed.",
        ok: (checked: string, at: string) =>
          `${checked} records were checked from the start to the end. Last checked ${at}.`,
        truncated: (checked: string, at: string) =>
          `${checked} records were checked, but the check ran out of time before the newest ones. Last checked ${at}.`,
        bad: (unverified: string, at: string) =>
          `${unverified} records did not verify. Last checked ${at}.`,
        failed: "The integrity check did not answer. Try again in a moment.",
      },
      checkNow: "Check now",
      checking: "Checking...",
      seeDetails: "See details",
    },
  },
  ko: {
    title: "관리자 활동 기록",
    description:
      "관리자가 바꾼 일이 모두 남아요. 기록은 사슬로 이어져 있어서 몰래 고칠 수 없어요.",
    rowLimit: (limit: number) =>
      ` 최근 ${limit}건만 보여 주고, 아래 필터도 이 안에서만 찾아요.`,
    requestedEntry: "링크로 열린 기록",
    openFullEntry: "전체 기록 열기",
    missingEntryBefore: "이 ID의 감사 기록이 없어요:",
    missingEntryAfter:
      ". 오래된 링크이거나 다른 환경의 기록일 수 있어요.",
    unknownAdmin: "알 수 없는 관리자",
    summaryLine: (events: number, actors: number, highRisk: number) =>
      `기록 ${events}건 · ${actors}명 · 위험한 작업 ${highRisk}건`,
    exportCsv: "CSV 내보내기",
    searchPlaceholder: "사람, 동작, 대상, 요약, IP로 찾기",
    searchLabel: "감사 기록 찾기",
    allTargets: "모든 대상",
    allActors: "모든 사람",
    targetFilter: "대상 종류",
    actorFilter: "사람",
    columns: {
      actor: "누가",
      action: "무엇을",
      target: "대상",
      time: "언제",
      context: "상세",
    },
    table: "관리자 활동",
    details: "상세",
    noMatches: "지금 필터에 맞는 기록이 없어요.",
    footer:
      "결제, 환불, 사용자 삭제를 바꾼 뒤에는 이 기록을 꼭 살펴봐 주세요. 운영을 조사하는 용도이고 고객에게 보여 주는 자료가 아니에요.",
    detail: {
      title: "감사 기록",
      target: "대상",
      request: "어디서 왔나요",
      summary: "무슨 일이 있었나요",
      who: "누가",
      when: "언제",
      copy: "복사",
      close: "닫기",
      tech: "요청과 메타데이터",
    },
    toast: {
      copied: "감사 기록을 복사했어요.",
      copyFailed: "감사 기록을 복사하지 못했어요.",
      detailFailed: "감사 상세를 불러오지 못했어요.",
    },
    integrityCard: {
      title: {
        idle: "기록 사슬을 아직 검사하지 않았어요",
        ok: "기록 사슬이 온전해요",
        truncated: "최신 기록까지 검사하지 못했어요",
        bad: "기록 사슬에 문제가 있어요",
        failed: "검사를 실행하지 못했어요",
      },
      detail: {
        idle: "지금 검사를 누르면 첫 기록부터 모두 읽어서 바뀐 곳이 없는지 확인해요.",
        ok: (checked: string, at: string) =>
          `${checked}개 기록을 처음부터 끝까지 확인했어요. 마지막 검사 ${at}.`,
        truncated: (checked: string, at: string) =>
          `${checked}개 기록을 확인했지만 시간이 모자라 최신 기록은 보지 못했어요. 마지막 검사 ${at}.`,
        bad: (unverified: string, at: string) =>
          `기록 ${unverified}개가 검증되지 않았어요. 마지막 검사 ${at}.`,
        failed: "무결성 검사가 답하지 않았어요. 잠시 뒤에 다시 시도해 주세요.",
      },
      checkNow: "지금 검사",
      checking: "검사하는 중...",
      seeDetails: "자세히 보기",
    },
  },
});
