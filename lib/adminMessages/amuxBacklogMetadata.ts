import { defineAdminMessages } from "@/lib/adminLocale";

export const adminAmuxBacklogMetadataMessages = defineAdminMessages({
  en: {
    title: "AMUX backlog metadata",
    description:
      "Changes the kind, priority and cost estimate of one unowned backlog card that has no execution brief. Preview checks the request and the card and writes nothing. Apply writes those three fields and the next revision, with an audit entry, when the server reports that apply is permitted. This screen cannot set that permission, change a card's status, or start a worker.",
    requestLabel: "Metadata request",
    preview: "Preview",
    apply: "Apply",
    applyDisabled: "Apply is disabled. The server refuses it even if this control is bypassed.",
    applyWaiting:
      "Apply opens once a preview of this exact request reports it valid and permitted. Editing the request or applying it closes Apply until the next preview.",
    renewSignIn: "Renew administrator sign-in",
    error: (code: string) => `Error: ${code}`,
    code: (code: string) => `Request refused: ${code}`,
    refusal: (code: string) => `Card refused: ${code}`,
    valid: (valid: string) => `Valid: ${valid}`,
    applyPermitted: (permitted: string) => `Apply permitted: ${permitted}`,
    status: (status: string) => `Status: ${status}`,
    revision: (revision: number) => `New revision: ${revision}.`,
  },
  ko: {
    title: "AMUX backlog 메타데이터",
    description:
      "owner가 없고 실행 brief가 없는 backlog 카드 한 건의 kind, priority, 비용 추정만 바꿉니다. 미리보기는 요청과 카드를 확인하고 아무것도 쓰지 않습니다. 적용은 서버가 적용을 허용했다고 보고할 때만 그 세 필드와 다음 revision을 감사 기록과 함께 씁니다. 이 화면은 그 허용을 켜거나, 카드 상태를 바꾸거나, 워커를 시작하지 않습니다.",
    requestLabel: "메타데이터 요청",
    preview: "미리보기",
    apply: "적용",
    applyDisabled: "적용은 꺼져 있습니다. 이 버튼을 우회해도 서버가 거절합니다.",
    applyWaiting:
      "이 요청 그대로의 미리보기가 유효하고 허용됐다고 보고하면 적용이 열립니다. 요청을 고치거나 적용하면 다음 미리보기 전까지 다시 닫힙니다.",
    renewSignIn: "관리자 로그인을 갱신",
    error: (code: string) => `오류: ${code}`,
    code: (code: string) => `요청 거절: ${code}`,
    refusal: (code: string) => `카드 거절: ${code}`,
    valid: (valid: string) => `유효: ${valid}`,
    applyPermitted: (permitted: string) => `적용 허용: ${permitted}`,
    status: (status: string) => `상태: ${status}`,
    revision: (revision: number) => `새 revision: ${revision}.`,
  },
});
