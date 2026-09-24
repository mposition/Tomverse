import { defineAdminMessages } from "@/lib/adminLocale";

export const adminAmuxBoardRecommendationMessages = defineAdminMessages({
  en: {
    title: "AMUX recommendation pool",
    description:
      "Preview reads the backlog and writes nothing. Prepare stores a snapshot only when the server says this pool is permitted. A decision approves one included card, or holds or rejects one row. This screen cannot turn the switch on or start a worker.",
    requestLabel: "Recommendation request",
    preview: "Preview",
    prepare: "Prepare",
    decide: "Decide",
    renewSignIn: "Renew administrator sign-in",
    error: (code: string) => `Error: ${code}`,
    status: (status: string) => `Status: ${status}`,
    refusal: (code: string) => `Refusal: ${code}`,
    applyPermitted: (permitted: string) => `Apply permitted: ${permitted}`,
    included: (count: number) => `Included: ${count}.`,
  },
  ko: {
    title: "AMUX 추천 풀",
    description:
      "미리보기는 backlog를 읽고 아무것도 쓰지 않습니다. 준비는 서버가 이 풀을 허용했다고 보고할 때만 snapshot을 저장합니다. 결정은 포함된 카드 하나를 승인하거나, 한 행을 보류하거나 거절합니다. 이 화면은 스위치를 켜거나 워커를 시작하지 않습니다.",
    requestLabel: "추천 요청",
    preview: "미리보기",
    prepare: "준비",
    decide: "결정",
    renewSignIn: "관리자 로그인을 갱신",
    error: (code: string) => `오류: ${code}`,
    status: (status: string) => `상태: ${status}`,
    refusal: (code: string) => `거절: ${code}`,
    applyPermitted: (permitted: string) => `적용 허용: ${permitted}`,
    included: (count: number) => `포함: ${count}.`,
  },
});
