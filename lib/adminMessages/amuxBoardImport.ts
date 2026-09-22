import { defineAdminMessages } from "@/lib/adminLocale";

export const adminAmuxBoardImportMessages = defineAdminMessages({
  en: {
    title: "AMUX catalog import",
    description:
      "Preview reads the catalog and writes nothing. Prepare, approve, reject and expire record an approval. Apply stays off until a separate production approval. This screen cannot turn it on.",
    manifestLabel: "Catalog manifest",
    preview: "Preview",
    prepare: "Prepare",
    approvalLabel: "Approval id",
    approve: "Approve",
    reject: "Reject",
    expire: "Expire",
    expireDue: "Expire due",
    apply: "Apply",
    applyDisabled:
      "Apply is disabled. The server refuses it even if this control is bypassed.",
    renewSignIn: "Renew administrator sign-in",
    error: (code: string) => `Error: ${code}`,
    status: (status: string) => `Status: ${status}`,
    refusal: (code: string) => `Refusal: ${code}`,
    applyPermitted: (permitted: string) => `Apply permitted: ${permitted}`,
    counts: (create: number, noOp: number, conflict: number, exclude: number) =>
      `Create ${create}, no-op ${noOp}, conflict ${conflict}, exclude ${exclude}.`,
    sourceMissingAllPresent: "This catalog includes every stored source row.",
    sourceMissing: (count: number) =>
      `This catalog does not include ${count} stored source row(s). They stay in place.`,
    sourceMissingTruncated: (count: number) =>
      `This catalog does not include at least ${count} stored source row(s). The scan stopped at its cap, and nothing was deleted.`,
    sourceMissingScanStopped:
      "The scan stopped at its cap before it could finish. Nothing was deleted.",
  },
  ko: {
    title: "AMUX 카탈로그 이관",
    description:
      "미리보기는 카탈로그를 읽고 아무것도 쓰지 않습니다. 준비, 승인, 거절, 만료는 승인 기록만 남깁니다. 적용은 별도의 운영 승인이 있을 때까지 꺼져 있으며, 이 화면에서는 켤 수 없습니다.",
    manifestLabel: "카탈로그 매니페스트",
    preview: "미리보기",
    prepare: "준비",
    approvalLabel: "승인 ID",
    approve: "승인",
    reject: "거절",
    expire: "만료",
    expireDue: "기한 지난 항목 만료",
    apply: "적용",
    applyDisabled:
      "적용은 꺼져 있습니다. 이 버튼을 우회해도 서버가 거절합니다.",
    renewSignIn: "관리자 로그인을 갱신",
    error: (code: string) => `오류: ${code}`,
    status: (status: string) => `상태: ${status}`,
    refusal: (code: string) => `거절 사유: ${code}`,
    applyPermitted: (permitted: string) => `적용 허용: ${permitted}`,
    counts: (create: number, noOp: number, conflict: number, exclude: number) =>
      `생성 ${create}, 변경 없음 ${noOp}, 충돌 ${conflict}, 제외 ${exclude}.`,
    sourceMissingAllPresent: "이 카탈로그는 저장된 원본 행을 모두 포함합니다.",
    sourceMissing: (count: number) =>
      `이 카탈로그에 없는 저장된 원본 행이 ${count}건입니다. 그 행은 그대로 둡니다.`,
    sourceMissingTruncated: (count: number) =>
      `이 카탈로그에 없는 저장된 원본 행이 최소 ${count}건입니다. 조회가 상한에서 멈췄고, 아무것도 지우지 않았습니다.`,
    sourceMissingScanStopped:
      "조회가 상한에서 끝나기 전에 멈췄습니다. 아무것도 지우지 않았습니다.",
  },
});
