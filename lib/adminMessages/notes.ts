import { defineAdminMessages } from "@/lib/adminLocale";

const KO_TARGET_NOUNS: Readonly<Record<string, string>> = {
  User: "사용자",
  RefundRequest: "환불 요청",
  Feedback: "피드백",
  BillingConfig: "결제 설정",
  Model: "모델",
};

const koTarget = (targetType: string) => KO_TARGET_NOUNS[targetType] ?? targetType;

/** Copy for the internal notes box shared by several detail panels. */
export const adminNotesMessages = defineAdminMessages({
  en: {
    loadFailed: (targetType: string) =>
      `Existing notes on this ${targetType.toLowerCase()} could not be loaded, so the list below is incomplete.`,
    saveFailed: "The note was not saved. Your text is still in the box -- retry.",
    saved: (targetType: string) =>
      `Admin note saved on this ${targetType.toLowerCase()}.`,
    title: "Internal notes",
    visibility: "Visible only to Admin operators.",
    placeholder: "Add context, follow-up, risk notes, or customer handling details...",
    save: "Save note",
    empty: "No internal notes yet.",
    fallbackAuthor: "Admin",
  },
  ko: {
    loadFailed: (targetType: string) =>
      `이 ${koTarget(targetType)}의 기존 메모를 불러오지 못해 아래 목록이 불완전합니다.`,
    saveFailed: "메모가 저장되지 않았습니다. 입력한 내용은 입력란에 그대로 있으니 다시 시도하세요.",
    saved: (targetType: string) => `이 ${koTarget(targetType)}에 관리자 메모를 저장했습니다.`,
    title: "내부 메모",
    visibility: "관리자 운영자에게만 표시됩니다.",
    placeholder: "배경, 후속 조치, 위험 메모, 고객 대응 내용을 입력하세요...",
    save: "메모 저장",
    empty: "아직 내부 메모가 없습니다.",
    fallbackAuthor: "관리자",
  },
});
