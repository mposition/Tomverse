import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the data rights (privacy) request queue on the Support page. */
export const adminPrivacyRequestsMessages = defineAdminMessages({
  en: {
    toast: {
      updateFailed: "Privacy request update failed.",
      updated: "Privacy request updated.",
      loadFailed: "Privacy queue load failed.",
      createFailed: "Privacy request creation failed.",
      added: "Privacy request added.",
    },
    card: {
      due: (requestType: string, dueAt: string) => `${requestType} · due ${dueAt}`,
      legalHold: "Legal hold",
      statuses: {
        open: "Open",
        in_progress: "In progress",
        completed: "Completed",
        rejected: "Rejected",
      },
      dueDate: "Privacy request due date",
      legalException: "Legal retention exception",
      legalHoldReason: "Legal hold reason",
      legalHoldReasonPlaceholder: "Required legal hold reason",
      operatorNote: "Operator note",
      save: "Save request",
    },
    eyebrow: "Privacy operations",
    title: "Data rights request queue",
    description:
      "Track access, export, deletion, correction, deadlines, and documented legal retention exceptions.",
    refresh: "Refresh",
    customerEmail: "Customer email",
    requestTypes: {
      access: "Access",
      export: "Export",
      deletion: "Deletion",
      correction: "Correction",
    },
    add: "Add request",
    empty: "No privacy requests.",
    loadNext: "Load next 30",
  },
  ko: {
    toast: {
      updateFailed: "개인정보 요청을 업데이트하지 못했습니다.",
      updated: "개인정보 요청을 업데이트했습니다.",
      loadFailed: "개인정보 요청 대기열을 불러오지 못했습니다.",
      createFailed: "개인정보 요청을 추가하지 못했습니다.",
      added: "개인정보 요청을 추가했습니다.",
    },
    card: {
      due: (requestType: string, dueAt: string) => `${requestType} · 기한 ${dueAt}`,
      legalHold: "법적 보존",
      statuses: {
        open: "접수",
        in_progress: "처리 중",
        completed: "완료",
        rejected: "거절",
      },
      dueDate: "개인정보 요청 기한",
      legalException: "법적 보존 예외",
      legalHoldReason: "법적 보존 사유",
      legalHoldReasonPlaceholder: "법적 보존 사유 (필수)",
      operatorNote: "운영자 메모",
      save: "요청 저장",
    },
    eyebrow: "개인정보 운영",
    title: "정보주체 권리 요청 대기열",
    description:
      "열람, 내보내기, 삭제, 정정 요청과 기한, 문서화된 법적 보존 예외를 추적합니다.",
    refresh: "새로고침",
    customerEmail: "고객 이메일",
    requestTypes: {
      access: "열람",
      export: "내보내기",
      deletion: "삭제",
      correction: "정정",
    },
    add: "요청 추가",
    empty: "개인정보 요청이 없습니다.",
    loadNext: "다음 30건 불러오기",
  },
});
