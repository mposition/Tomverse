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
      overdue: "Past due",
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
    title: "Data rights request queue",
    description:
      "Track access, export, deletion, correction, deadlines, and documented legal retention exceptions.",
    refresh: "Refresh",
    addTitle: "Add a request",
    addDescription: "Record a request that came in by email. It is due in 30 days.",
    customerEmail: "Customer email",
    requestTypeLabel: "Request type",
    requestTypes: {
      access: "Access",
      export: "Export",
      deletion: "Deletion",
      correction: "Correction",
    },
    add: "Add request",
    empty: "No privacy requests.",
    readFailedTitle: "The privacy requests could not be read.",
    readFailedDetail:
      "They are not shown as empty on purpose, because that would hide a request with a deadline. Try again in a moment.",
    loadNext: "Load next 30",
  },
  ko: {
    toast: {
      updateFailed: "개인정보 요청을 바꾸지 못했어요.",
      updated: "개인정보 요청을 바꿨어요.",
      loadFailed: "개인정보 요청 대기열을 불러오지 못했어요.",
      createFailed: "개인정보 요청을 추가하지 못했어요.",
      added: "개인정보 요청을 추가했어요.",
    },
    card: {
      due: (requestType: string, dueAt: string) => `${requestType} · 기한 ${dueAt}`,
      legalHold: "법적 보존",
      overdue: "기한 지남",
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
    title: "정보주체 권리 요청 대기열",
    description:
      "열람, 내보내기, 삭제, 정정 요청과 기한, 문서로 남긴 법적 보존 예외를 챙겨요.",
    refresh: "새로고침",
    addTitle: "요청 추가",
    addDescription: "이메일로 들어온 요청을 기록해요. 기한은 30일 뒤예요.",
    customerEmail: "고객 이메일",
    requestTypeLabel: "요청 종류",
    requestTypes: {
      access: "열람",
      export: "내보내기",
      deletion: "삭제",
      correction: "정정",
    },
    add: "요청 추가",
    empty: "개인정보 요청이 없어요.",
    readFailedTitle: "개인정보 요청을 읽지 못했어요.",
    readFailedDetail:
      "기한이 있는 요청이 가려지지 않도록 빈 목록으로 보여 주지 않아요. 잠시 뒤에 다시 시도해 주세요.",
    loadNext: "다음 30건 불러오기",
  },
});
