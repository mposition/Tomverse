import { defineAdminMessages } from "@/lib/adminLocale";

export const adminAmuxLocalIntakeMessages = defineAdminMessages({
  en: {
    title: "Local analysis import",
    description:
      "Import one analysis package from the operator PC. This screen does not call a model. Each card needs its own confirmation.",
    draftLabel: "AI analysis draft",
    notRegistered: "Not registered yet",
    backlogMeaning: "Registering a backlog card is not execution and does not promote it to todo.",
    perCard: "Each card needs its own operator confirmation.",
    snapshot: "Download snapshot",
    preview: "Preview",
    register: "Register this card",
    registerDisabled: "Register is disabled. The server refuses it even if this control is bypassed.",
    registerPermitted: "Register creates one backlog card. It does not promote the card or start a worker.",
    inactive: "Registration is inactive.",
    outcomeUnknown: "The result is unknown. This screen did not continue to the next card.",
    reconfirm: "The card changed after confirmation. Confirm the new digest.",
    error: (code: string) => `Error: ${code}`,
    renewSignIn: "Renew administrator sign-in",
    cardLine: (localId: string, title: string, priority: string) => `${localId}: ${title} (${priority})`,
  },
  ko: {
    title: "로컬 분석 가져오기",
    description:
      "운영자 PC에서 만든 분석 package를 가져옵니다. 이 화면은 모델을 호출하지 않습니다. 카드마다 확인이 필요합니다.",
    draftLabel: "AI 분석 초안",
    notRegistered: "아직 등록되지 않음",
    backlogMeaning: "backlog 등록은 실행이나 todo 승격이 아님",
    perCard: "등록할 카드별로 운영자 확인 필요",
    snapshot: "스냅샷 내려받기",
    preview: "미리보기",
    register: "이 카드 등록",
    registerDisabled: "등록은 꺼져 있습니다. 이 버튼을 우회해도 서버가 거절합니다.",
    registerPermitted: "등록은 backlog 카드 한 건을 만듭니다. 카드를 승격하거나 워커를 시작하지 않습니다.",
    inactive: "등록은 비활성입니다.",
    outcomeUnknown: "결과를 확정하지 못했습니다. 이 화면은 다음 카드로 진행하지 않았습니다.",
    reconfirm: "확인 뒤에 카드가 바뀌었습니다. 새 다이제스트를 다시 확인하세요.",
    error: (code: string) => `오류: ${code}`,
    renewSignIn: "관리자 로그인을 갱신",
    cardLine: (localId: string, title: string, priority: string) => `${localId}: ${title} (${priority})`,
  },
});
