import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for `AdminOperationalReadinessPanel`. */
export const adminOperationalReadinessMessages = defineAdminMessages({
  en: {
    eyebrow: "Operational assurance",
    title: "Recovery and access checkpoints",
    description:
      "Record provider-confirmed backup evidence, restore drills, access reviews, and external audit archives without claiming automated verification.",
    refresh: "Refresh",
    verifiedAt: (date: string) => `Verified ${date}`,
    neverVerified: "Never verified",
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
    toast: {
      updated: (name: string) => `${name} checkpoint updated.`,
      updateFailed: "Checkpoint update failed.",
      loadFailed: "Could not load operational checkpoints.",
    },
  },
  ko: {
    eyebrow: "운영 보증",
    title: "복구 및 접근 체크포인트",
    description:
      "공급자가 확인한 백업 증거, 복구 훈련, 접근 검토, 외부 감사 아카이브를 기록합니다. 자동으로 검증되었다고 주장하지 않습니다.",
    refresh: "새로고침",
    verifiedAt: (date: string) => `검증 ${date}`,
    neverVerified: "검증 기록 없음",
    status: {
      healthy: "정상",
      warning: "경고",
      failed: "실패",
      not_configured: "미구성",
    },
    nextDue: (name: string) => `${name} 다음 점검 예정일`,
    detailPlaceholder: "검증 결과 또는 운영자 메모",
    evidencePlaceholder: "증거 URL (선택)",
    verifyCheckpoint: "체크포인트 검증",
    toast: {
      updated: (name: string) => `${name} 체크포인트를 갱신했습니다.`,
      updateFailed: "체크포인트 갱신에 실패했습니다.",
      loadFailed: "운영 체크포인트를 불러오지 못했습니다.",
    },
  },
});
