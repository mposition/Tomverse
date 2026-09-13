import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the Scheduled jobs panel under Automation. */
export const adminScheduledJobsMessages = defineAdminMessages({
  en: {
    never: "Never",
    unknown: "Unknown",
    loadFailed: "Could not load scheduled jobs.",
    eyebrow: "Automation health",
    title: "Scheduled jobs",
    description:
      "A job is marked delayed when Railway has not called it within its expected interval.",
    refresh: "Refresh",
    loading: "Loading job history…",
    status: "Status: ",
    lastRun: "Last run: ",
    lastSuccess: "Last success: ",
    nextExpected: "Next expected: ",
    processed: "Processed: ",
    consecutiveFailures: "Consecutive failures: ",
  },
  ko: {
    never: "없음",
    unknown: "알 수 없음",
    loadFailed: "예약 작업을 불러오지 못했습니다.",
    eyebrow: "자동화 상태",
    title: "예약 작업",
    description:
      "Railway가 예상 주기 안에 작업을 호출하지 않으면 지연으로 표시됩니다.",
    refresh: "새로고침",
    loading: "작업 이력을 불러오는 중…",
    status: "상태: ",
    lastRun: "마지막 실행: ",
    lastSuccess: "마지막 성공: ",
    nextExpected: "다음 예정: ",
    processed: "처리 건수: ",
    consecutiveFailures: "연속 실패: ",
  },
});
