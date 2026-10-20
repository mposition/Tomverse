import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the Auto LLM router control on Admin › Routing. */
export const adminAutoLlmRouterMessages = defineAdminMessages({
  en: {
    title: "Auto per-prompt model choice",
    description:
      "A small model reads each Auto message and picks the answering model from the candidates that passed plan, credit, context and health checks. Every decision is kept as training data for an in-house triage. Off keeps the cheapest-eligible rule.",
    label: "Router model",
    off: "Off (rule only)",
    save: "Save",
    saving: "Saving...",
    saved: "Saved.",
    loadFailed: "Could not load the setting.",
    saveFailed: "Could not save the setting.",
    costNote: "Each Auto turn adds one small provider request, paid from the provider budget, not the user's credits.",
    rewriteLabel: "Also rewrite each message for the answering model",
    rewriteDescription: "The same router call restates a short message as a self-contained request (resolving \"the code above\" and the like), and the answering model reads that instead. The user's message is saved as written, and the reply shows how Auto read it. Off by default.",
    imageTriageLabel: "Also triage chat image requests",
    imageTriageDescription: "Before a chat message is sent, the router model checks whether it asks for an image. If it does, the message opens in the image workspace with an image model and preset matched to its complexity: a stronger model for detailed work, a cheaper one for simple images. Generation still needs the user's own auto-generate choice or a press beside the price. Adds one provider request per chat send for accounts that can generate images. Off by default.",
  },
  ko: {
    title: "Auto 프롬프트별 모델 선택",
    description:
      "작은 모델이 Auto 메시지를 하나씩 읽고, 플랜·크레딧·context·장애 검사를 통과한 후보 중에서 답변 모델을 고릅니다. 모든 판정은 자체 Triage 학습 데이터로 저장됩니다. 끄면 가장 저렴한 후보를 고르는 기존 규칙만 씁니다.",
    label: "라우터 모델",
    off: "끔 (규칙만 사용)",
    save: "저장",
    saving: "저장 중...",
    saved: "저장했습니다.",
    loadFailed: "설정을 불러오지 못했습니다.",
    saveFailed: "설정을 저장하지 못했습니다.",
    costNote: "Auto 턴마다 작은 provider 요청이 하나 추가되며, 사용자 크레딧이 아니라 provider 예산에서 나갑니다.",
    rewriteLabel: "답변 모델용으로 메시지도 다시 쓰기",
    rewriteDescription: "같은 router 호출이 짧은 메시지를 문맥이 담긴 독립적인 요청으로 다시 쓰고(\"위 코드\" 같은 지칭 해석), 답변 모델은 그 문장을 읽습니다. 사용자 메시지는 쓴 그대로 저장되고, 답변에 Auto가 어떻게 이해했는지 표시됩니다. 기본은 꺼짐입니다.",
    imageTriageLabel: "채팅의 이미지 요청도 Triage하기",
    imageTriageDescription: "채팅 메시지를 보내기 전에 라우터 모델이 이미지 요청인지 판단합니다. 이미지 요청이면 이미지 작업 공간으로 열고, 복잡도에 맞는 이미지 모델과 품질을 고릅니다. 정교한 이미지에는 상위 모델, 간단한 이미지에는 저렴한 모델을 씁니다. 생성은 여전히 사용자의 자동 생성 설정이나 가격 옆 버튼 클릭이 있어야 시작됩니다. 이미지를 생성할 수 있는 계정의 채팅 전송마다 provider 요청이 하나 추가됩니다. 기본은 꺼짐입니다.",
  },
});
