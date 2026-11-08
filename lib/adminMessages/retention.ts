import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the retention workspace (`AdminRetentionPanel`). */
export const adminRetentionMessages = defineAdminMessages({
  en: {
    title: "Data retention operations",
    description:
      "How long each kind of data is kept, and how much is already past its window and waiting for the next cleanup.",
    refresh: "Refresh",
    table: "Retention by data type",
    columns: {
      data: "Data",
      rule: "How long it is kept",
      waiting: "Waiting for cleanup",
      oldest: "Oldest record",
    },
    action: {
      delete: "Deleted",
      clear: "Fields cleared",
      refund: "Settled by refund",
      keep: "Kept",
    },
    beyondFloor: "Beyond the floor",
    cleanupCount: "Cleanup count",
    oldestRecord: "Oldest record",
    loading: "Loading retention status...",
    loadFailedTitle: "Could not load the retention status",
    loadFailedDetail: "Nothing is shown rather than a guess. Try again.",
    pending: {
      title: (records: string, kinds: number) =>
        `${records} records in ${kinds} kinds of data are past their window`,
      detail:
        "The next cleanup will remove or empty them, and that cannot be undone. Run a dry run first to see exactly what goes.",
    },
    manualCleanup: "Manual cleanup",
    manualCleanupHelp: "Run a dry run first. To execute cleanup, type RUN CLEANUP exactly.",
    dryRunAt: (ranAt: string) => `Dry run ${ranAt}`,
    dryRun: "Dry run",
    executeCleanup: "Execute cleanup",
    confirmLabel: "Type RUN CLEANUP to unlock the execute button",
    signInAgain: "Sign in again to continue",
    toast: {
      loadFailed: "Could not load retention status.",
      cleanupFailed: "Cleanup operation failed.",
      executed: "Cleanup executed.",
      dryRunCompleted: "Cleanup dry run completed.",
    },
  },
  ko: {
    title: "데이터 보존과 삭제",
    description:
      "데이터마다 얼마나 오래 두는지, 그리고 이미 기간이 지나 다음 정리를 기다리는 기록이 얼마나 되는지 보여 줘요.",
    refresh: "새로고침",
    table: "데이터별 보존 기간",
    columns: {
      data: "데이터",
      rule: "얼마나 두나요",
      waiting: "정리 대기",
      oldest: "가장 오래된 기록",
    },
    action: {
      delete: "삭제",
      clear: "내용만 비움",
      refund: "환불로 정산",
      keep: "계속 보관",
    },
    beyondFloor: "보존 하한 초과",
    cleanupCount: "정리 대상 수",
    oldestRecord: "가장 오래된 기록",
    loading: "보존 현황을 불러오는 중...",
    loadFailedTitle: "보존 현황을 불러오지 못했어요",
    loadFailedDetail: "추측해서 보여 주지 않고 비워 뒀어요. 다시 시도해 주세요.",
    pending: {
      title: (records: string, kinds: number) =>
        `데이터 ${kinds}종, ${records}건이 보존 기간을 넘겼어요`,
      detail:
        "다음 정리 때 지우거나 비워지고, 되돌릴 수 없어요. 먼저 dry run으로 무엇이 지워지는지 확인해 주세요.",
    },
    manualCleanup: "수동 정리",
    manualCleanupHelp:
      "먼저 dry run을 실행해 주세요. 정리를 실행하려면 RUN CLEANUP을 정확히 입력해야 해요.",
    dryRunAt: (ranAt: string) => `Dry run ${ranAt}`,
    dryRun: "Dry run 실행",
    executeCleanup: "정리 실행",
    confirmLabel: "RUN CLEANUP을 입력하면 실행 버튼이 열려요",
    signInAgain: "다시 로그인하고 계속하기",
    toast: {
      loadFailed: "보존 현황을 불러오지 못했어요.",
      cleanupFailed: "정리 작업이 실패했어요.",
      executed: "정리를 실행했어요.",
      dryRunCompleted: "정리 dry run을 마쳤어요.",
    },
  },
});
