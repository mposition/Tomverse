import type { AssistantKnowledgeGuideStep } from "@/lib/assistantKnowledgeGuide";

export type AssistantKnowledgeGuideCopy = {
  eyebrow: string;
  title: string;
  description: string;
  posterAlt: string;
  mediaLabel: string;
  videoLabel: string;
  videoHint: string;
  stepsHeading: string;
  steps: Array<{
    id: AssistantKnowledgeGuideStep;
    label: string;
    title: string;
    body: string;
    previewTitle: string;
    previewBody: string;
  }>;
  boundaryTitle: string;
  boundaryBody: string;
  ctaAuthenticated: string;
  ctaGuest: string;
  ctaHint: string;
  videoUnavailable: string;
};

export const assistantKnowledgeGuideContent: Record<
  "ko" | "en",
  AssistantKnowledgeGuideCopy
> = {
  ko: {
    eyebrow: "나의 AI 어시스턴트 + Knowledge",
    title: "내 방식과 내 자료를 아는 AI. 단 3단계면 준비됩니다",
    description:
      "무엇을 설정하고 어디에서 파일을 추가하며, 대화에서 어떻게 사용하는지 먼저 확인해 보세요. 각 단계를 눌러 실제 흐름을 미리 볼 수 있습니다.",
    posterAlt:
      "나의 AI 어시스턴트 생성, Knowledge 추가, 대화에서 사용의 3단계 Tomverse 안내",
    mediaLabel: "인터랙티브 사용법",
    videoLabel: "무음 사용법 영상",
    videoHint: "한국어 자막이 자동으로 켜져 음성 없이도 전체 흐름을 볼 수 있습니다.",
    stepsHeading: "직접 눌러보는 3단계",
    steps: [
      {
        id: "create_assistant",
        label: "1단계",
        title: "어시스턴트 만들기",
        body: "이름과 원하는 답변 방식만 적으면 첫 버전이 바로 준비됩니다.",
        previewTitle: "이름 + 사용자 정의 지시",
        previewBody:
          "예: ‘프로젝트 브리핑 도우미’ / ‘결론과 근거를 먼저, 다음 행동을 짧게 제안해 주세요.’",
      },
      {
        id: "add_knowledge",
        label: "2단계",
        title: "Knowledge 추가하고 저장하기",
        body: "내 자료를 업로드하고 이 버전에서 사용할 파일을 선택한 뒤 변경사항을 저장합니다.",
        previewTitle: "Knowledge 파일 선택",
        previewBody:
          "처리가 끝난 파일을 선택하고 ‘지시문과 모델 저장’을 누르면 관련 발췌를 답변의 참고 자료로 쓸 수 있습니다.",
      },
      {
        id: "start_chat",
        label: "3단계",
        title: "대화에서 사용하기",
        body: "대화 도구의 AI 어시스턴트 메뉴에서 방금 만든 어시스턴트를 선택합니다.",
        previewTitle: "대화 도구 → AI 어시스턴트",
        previewBody:
          "선택한 버전의 지시와 질문에 관련된 Knowledge 발췌가 새 답변의 참고 맥락으로 사용됩니다.",
      },
    ],
    boundaryTitle: "내 계정 안에서 비공개",
    boundaryBody:
      "어시스턴트와 Knowledge는 공개 목록이나 다른 사용자에게 공유되지 않습니다. Knowledge는 관련 발췌를 참고 자료로 제공하며, 중요한 답은 원문과 함께 확인하세요.",
    ctaAuthenticated: "내 AI 어시스턴트 만들기",
    ctaGuest: "로그인하고 시작하기",
    ctaHint: "설정 진행 상태는 실제 저장 결과를 기준으로 이어집니다.",
    videoUnavailable:
      "영상이 없어도 같은 내용을 끝까지 볼 수 있도록 인터랙티브 안내를 제공합니다.",
  },
  en: {
    eyebrow: "My AI Assistant + Knowledge",
    title: "Three steps to an AI that works your way, with your material",
    description:
      "See what to configure, where to add files, and how to use the assistant in a conversation. Select each step to preview the real flow.",
    posterAlt:
      "Tomverse guide showing three steps: create an AI assistant, add Knowledge, and use it in a conversation",
    mediaLabel: "Interactive how-to",
    videoLabel: "Silent tutorial",
    videoHint: "English captions turn on automatically, so the complete flow works without audio.",
    stepsHeading: "Try the three steps",
    steps: [
      {
        id: "create_assistant",
        label: "Step 1",
        title: "Create your assistant",
        body: "A name and the way you want answers written are enough for the first version.",
        previewTitle: "Name + custom instructions",
        previewBody:
          "For example: ‘Project briefing assistant’ / ‘Lead with the conclusion and evidence, then suggest the next action briefly.’",
      },
      {
        id: "add_knowledge",
        label: "Step 2",
        title: "Add Knowledge and save",
        body: "Upload your material, select the files this version may use, then save the changes.",
        previewTitle: "Select Knowledge files",
        previewBody:
          "After processing finishes, select the file and save instructions and models so relevant excerpts can be used as reference material.",
      },
      {
        id: "start_chat",
        label: "Step 3",
        title: "Use it in a conversation",
        body: "Open AI Assistant in the conversation tools and choose the assistant you just made.",
        previewTitle: "Conversation tools → AI Assistant",
        previewBody:
          "The selected version's instructions and Knowledge excerpts relevant to your question become reference context for new answers.",
      },
    ],
    boundaryTitle: "Private to your account",
    boundaryBody:
      "Assistants and Knowledge are not published or shared with other users. Knowledge supplies relevant excerpts as reference material; check important answers against the source.",
    ctaAuthenticated: "Create my AI assistant",
    ctaGuest: "Sign in and start",
    ctaHint: "The setup guide resumes from what you have actually saved.",
    videoUnavailable:
      "The interactive guide contains the complete walkthrough even before the video is available.",
  },
};
