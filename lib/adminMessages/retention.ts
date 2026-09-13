import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the retention workspace (`AdminRetentionPanel`). */
export const adminRetentionMessages = defineAdminMessages({
  en: {
    eyebrow: "Retention",
    title: "Data retention operations",
    description:
      "Monitor expired credit reservations, usage buckets, request leases, share snapshots, product analytics, provider checks, alert logs, and audit retention.",
    refresh: "Refresh",
    beyondFloor: "Beyond the floor",
    cleanupCount: "Cleanup count",
    oldestRecord: "Oldest record",
    loading: "Loading retention status...",
    notLoaded: "Retention status has not loaded yet.",
    manualCleanup: "Manual cleanup",
    manualCleanupHelp: "Run a dry run first. To execute cleanup, type RUN CLEANUP exactly.",
    dryRunAt: (ranAt: string) => `Dry run ${ranAt} UTC`,
    dryRun: "Dry run",
    executeCleanup: "Execute cleanup",
    signInAgain: "Sign in again to continue",
    toast: {
      loadFailed: "Could not load retention status.",
      cleanupFailed: "Cleanup operation failed.",
      executed: "Cleanup executed.",
      dryRunCompleted: "Cleanup dry run completed.",
    },
  },
  ko: {
    eyebrow: "보존",
    title: "데이터 보존 작업",
    description:
      "만료된 크레딧 예약, 사용량 버킷, 요청 lease, 공유 스냅샷, 제품 분석, 공급자 점검, 알림 로그, 감사 로그 보존 현황을 확인합니다.",
    refresh: "새로고침",
    beyondFloor: "보존 하한 초과",
    cleanupCount: "정리 대상 수",
    oldestRecord: "가장 오래된 기록",
    loading: "보존 현황을 불러오는 중...",
    notLoaded: "보존 현황을 아직 불러오지 않았습니다.",
    manualCleanup: "수동 정리",
    manualCleanupHelp:
      "먼저 dry run을 실행하세요. 정리를 실행하려면 RUN CLEANUP을 정확히 입력하세요.",
    dryRunAt: (ranAt: string) => `Dry run ${ranAt} UTC`,
    dryRun: "Dry run 실행",
    executeCleanup: "정리 실행",
    signInAgain: "다시 로그인하고 계속하기",
    toast: {
      loadFailed: "보존 현황을 불러오지 못했습니다.",
      cleanupFailed: "정리 작업이 실패했습니다.",
      executed: "정리를 실행했습니다.",
      dryRunCompleted: "정리 dry run을 완료했습니다.",
    },
  },
});
