import { defineAdminMessages } from "@/lib/adminLocale";

export const adminAmuxReconciliationMessages = defineAdminMessages({
  en: {
    title: "AMUX source reconciliation",
    description:
      "Preview shows per-card accept or reject decisions and writes nothing. Apply opens after a valid preview. This screen cannot change a card lifecycle or start a worker.",
    requestLabel: "Reconciliation request",
    preview: "Preview",
    apply: "Apply",
    applyDisabled: "Apply is disabled. The server refuses it even if this control is bypassed.",
    applyPermitted: "Apply is permitted for this preview.",
    renewSignIn: "Renew administrator sign-in",
    error: (code: string) => `Error: ${code}`,
    counts: (drift: number, accept: number, reject: number) =>
      `Drift ${drift}, accept ${accept}, reject ${reject}.`,
  },
  ko: {
    title: "AMUX 소스 재조정",
    description:
      "미리보기는 카드별 수락 또는 거절을 보여주고 아무것도 쓰지 않습니다. 적용은 유효한 미리보기 뒤에 열립니다. 이 화면은 카드 수명주기를 바꾸거나 워커를 시작하지 않습니다.",
    requestLabel: "재조정 요청",
    preview: "미리보기",
    apply: "적용",
    applyDisabled: "적용은 꺼져 있습니다. 이 버튼을 우회해도 서버가 거절합니다.",
    applyPermitted: "이 미리보기에 대해 적용이 허용되어 있습니다.",
    renewSignIn: "관리자 로그인을 갱신",
    error: (code: string) => `오류: ${code}`,
    counts: (drift: number, accept: number, reject: number) =>
      `drift ${drift}건, 수락 ${accept}건, 거절 ${reject}건.`,
  },
});
