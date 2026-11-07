import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for `AdminOperationalReadinessPanel`. */
export const adminOperationalReadinessMessages = defineAdminMessages({
  en: {
    title: "Recovery and access checkpoints",
    description:
      "Record provider-confirmed backup evidence, restore drills, access reviews, and external audit archives without claiming automated verification.",
    refresh: "Refresh",
    readyCount: (ready: number, total: number) => `${ready} / ${total} ready`,
    state: {
      ready: "Ready",
      overdue: "Overdue",
      failed: "Failed",
      warning: "Needs attention",
      notConfigured: "Not set up",
      notVerified: "Not verified yet",
    },
    verifiedAt: (date: string) => `Verified ${date}`,
    neverVerified: "Never verified",
    nextDueAt: (date: string) => `Next due ${date}`,
    editHint: "Record a check",
    status: {
      healthy: "Healthy",
      warning: "Warning",
      failed: "Failed",
      not_configured: "Not configured",
    },
    nextDue: (name: string) => `${name} next due`,
    detailPlaceholder: "Verification result or operator note",
    evidencePlaceholder: "Optional evidence URL",
    verifyCheckpoint: "Verify checkpoint",
    loadFailedTitle: "Could not load the checkpoints",
    loadFailedDetail: "The list is left empty rather than guessed. Try again.",
    toast: {
      updated: (name: string) => `${name} checkpoint updated.`,
      updateFailed: "Checkpoint update failed.",
      loadFailed: "Could not load operational checkpoints.",
    },
  },
  ko: {
    title: "복구와 접근 점검",
    description:
      "공급자가 확인한 백업 증거, 복구 훈련, 접근 검토, 외부 감사 보관본을 기록해요. 자동으로 검증했다고 주장하지 않아요.",
    refresh: "새로고침",
    readyCount: (ready: number, total: number) => `${ready} / ${total} 준비됨`,
    state: {
      ready: "준비됨",
      overdue: "기한 지남",
      failed: "실패",
      warning: "주의",
      notConfigured: "설정 안 됨",
      notVerified: "아직 확인 안 함",
    },
    verifiedAt: (date: string) => `확인 ${date}`,
    neverVerified: "확인한 적 없어요",
    nextDueAt: (date: string) => `다음 점검 ${date}`,
    editHint: "점검 기록하기",
    status: {
      healthy: "정상",
      warning: "주의",
      failed: "실패",
      not_configured: "설정 안 됨",
    },
    nextDue: (name: string) => `${name} 다음 점검일`,
    detailPlaceholder: "확인 결과나 운영자 메모",
    evidencePlaceholder: "증거 URL (선택)",
    verifyCheckpoint: "점검 기록 저장",
    loadFailedTitle: "점검 목록을 불러오지 못했어요",
    loadFailedDetail: "추측해서 채우지 않고 비워 뒀어요. 다시 시도해 주세요.",
    toast: {
      updated: (name: string) => `${name} 점검을 기록했어요.`,
      updateFailed: "점검 기록을 저장하지 못했어요.",
      loadFailed: "운영 점검을 불러오지 못했어요.",
    },
  },
});
