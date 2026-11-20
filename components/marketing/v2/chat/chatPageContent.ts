import type { Language } from "@/lib/language";
import { chatPageTranslations } from "./chatPageContent.i18n";

/**
 * Copy for the V2 chat introduction page (/products/chat; approved concept, owner
 * 2026-11-20). Korean is the approved wording, checked against the code and the
 * 2026-11-19 production catalogue; English and the six other locales follow its
 * meaning.
 *
 * `{n}` is replaced with the number of providers in the live public model
 * catalogue, and `{c}` with a credit figure from the example in the page
 * component, so the page never states a number that is not data.
 */
export type ChatPageCopy = {
  /** Breadcrumb label for this product. */
  crumb: string;
  hero: {
    title: [string, string];
    body: string;
    primary: string;
    secondary: string;
    note: string;
    motionOff: string;
    motionOn: string;
  };
  adaptive: {
    eyebrow: string;
    title: [string, string];
    stepsLabel: string;
    /** Three steps: [title, one-line description]. */
    steps: Array<[string, string]>;
    original: string;
    refinerChip: string;
    refined: string;
    tags: [string, string, string];
    need: string;
    credits: string;
    chosenCredits: string;
    /** Notes under the three candidate models, in the order of the page. */
    routeNotes: [string, string, string];
    answerMeta: string;
    answer: string;
    followNote: string;
    note: string;
  };
  manual: {
    eyebrow: string;
    title: [string, string];
    body: string;
    /** `{models}` and `{calc}` become links to the models page and the credit calculator. */
    creditTick: [string, string];
    modelsLink: string;
    calcLink: string;
    compareTick: [string, string];
    say: string;
    selected: string;
    choose: string;
  };
  continue: {
    eyebrow: string;
    title: [string, string];
    body: string;
    steps: Array<[string, string]>;
    note: string;
  };
  tools: {
    eyebrow: string;
    title: [string, string];
    cards: Array<{ k: string; h: string; p: string; f: string }>;
  };
  create: {
    eyebrow: string;
    title: [string, string];
    body: string;
    cards: Array<{ k: string; h: string; p: string }>;
    original: string;
    edited: string;
    editSay: string;
    note: string;
  };
  plugins: {
    eyebrow: string;
    title: [string, string];
    body: string;
    ticks: Array<[string, string]>;
    connectTitle: string;
    connectAsk: string;
    connected: string;
    /** Three permission rows: [label, tag]. */
    scopes: Array<[string, string]>;
    customServer: string;
    note: string;
  };
  keep: {
    eyebrow: string;
    title: [string, string];
    cards: Array<{ k: string; h: string; p: string; f: string }>;
  };
  mobile: {
    eyebrow: string;
    title: [string, string];
    body: string;
    me: string;
    ai: string;
    compose: string;
  };
  cta: {
    title: [string, string];
    body: string;
    review: string;
    chat: string;
  };
};

export const chatPageSeo: Record<Language, { title: string; description: string }> = {
  ko: {
    title: "Tomverse 채팅",
    description: "질문을 자동으로 다듬고 여러 공급자의 모델 가운데 알맞은 모델로 답하는 Tomverse 채팅 소개",
  },
  en: {
    title: "Tomverse Chat",
    description: "Tomverse Chat refines your question automatically and answers with the model that fits it, from many providers.",
  },
  zh: {
    title: "Tomverse Chat",
    description: "Tomverse Chat 会自动优化你的问题，并从多家提供商的模型中选出合适的模型来回答。",
  },
  "zh-Hant": {
    title: "Tomverse Chat",
    description: "Tomverse Chat 會自動優化你的問題，並從多家供應商的模型中選出合適的模型來回答。",
  },
  fr: {
    title: "Tomverse Chat",
    description: "Tomverse Chat reformule votre question automatiquement et répond avec le modèle qui lui convient, parmi ceux de nombreux fournisseurs.",
  },
  de: {
    title: "Tomverse Chat",
    description: "Tomverse Chat verfeinert Ihre Frage automatisch und antwortet mit dem passenden Modell aus vielen Anbietern.",
  },
  es: {
    title: "Tomverse Chat",
    description: "Tomverse Chat pule tu pregunta automáticamente y responde con el modelo que mejor encaja, entre los de muchos proveedores.",
  },
  pt: {
    title: "Tomverse Chat",
    description: "O Tomverse Chat refina sua pergunta automaticamente e responde com o modelo mais adequado, entre os de vários provedores.",
  },
};

const ko: ChatPageCopy = {
  crumb: "채팅",
  hero: {
    title: ["질문만 하세요.", "모델은 Tomverse가 고릅니다."],
    body: "어떤 AI에게 물을지 고민하지 않아도 됩니다. Tomverse가 알아서 질문을 더 분명하게 다듬고, 공급자 {n}곳의 모델 가운데 그 질문에 맞는 모델로 답합니다. 마음에 드는 모델이 있다면 직접 선택해서 대화하실 수 있습니다.",
    primary: "채팅 시작하기",
    secondary: "모델 살펴보기",
    note: "가입 없이 바로 시작할 수 있습니다.",
    motionOff: "애니메이션 멈추기",
    motionOn: "애니메이션 다시 재생",
  },
  adaptive: {
    eyebrow: "스마트 자동(Smart Adaptive)",
    title: ["보내는 순간,", "세 가지 일이 일어납니다."],
    stepsLabel: "스마트 자동 단계",
    steps: [
      ["질문을 다듬고", "목적·조건·우선순위를 정리"],
      ["모델을 고르고", "성격·기능·품질·비용을 함께"],
      ["답합니다", "어느 모델이 답했는지 표시"],
    ],
    original: "이번 주말에 부모님이랑 서울 근처 갈 데 추천해줘 많이 안 걷는 곳으로 차는 있어",
    refinerChip: "✦ Prompt Refiner · 자동으로 다듬음",
    refined: "부모님과 함께 갈 서울 근교 당일 나들이 장소를 추천해 줘. 차로 이동하고, 많이 걷지 않는 곳이면 좋겠어.",
    tags: ["목적 · 당일 나들이", "조건 · 차로 이동", "우선순위 · 덜 걷기"],
    need: "이 질문에 필요한 것: 장소 추천 · 텍스트 답변 · 빠른 응답",
    credits: "{c} 크레딧",
    chosenCredits: "{c} 크레딧 · 선택",
    routeNotes: ["깊은 추론이 필요한 질문에", "이 질문에는 이걸로 충분", "가장 어려운 작업에"],
    answerMeta: "Gemini Flash-Lite가 답했습니다 · 스마트 자동 · {c} 크레딧",
    answer: "차로 1시간 안팎이고 주차장에서 가까운 곳 위주로 골랐어요. 정원형 수목원은 평지 산책로가 짧게 이어지고, 호숫가 카페 거리는 차에서 내려 바로 쉴 수 있어요. 출발 시간과 식사 장소를 알려 주시면 하루 동선으로 묶어 드릴게요.",
    followNote: "이어서 묻는 질문도 같은 방식으로 다시 고릅니다. 대화 중에 모델을 직접 바꿀 수도 있습니다.",
    note: "예시 화면입니다. 실제로 선택되는 모델과 크레딧은 질문, 플랜과 사용량에 따라 달라집니다.",
  },
  manual: {
    eyebrow: "직접 선택",
    title: ["마음에 드는 모델이", "있다면, 그 모델로."],
    body: "자동으로 맡겨도 되고, 직접 골라도 됩니다. 대화마다 바꿀 수 있어서 익숙한 모델로 시작했다가 필요할 때 다른 모델의 답을 들어 볼 수 있습니다.",
    creditTick: ["모델마다 짧은 요청의 기본 크레딧을 보고 고릅니다", "모델별 크레딧은 {models}에서, 한 달 사용량은 {calc}에서 볼 수 있습니다."],
    modelsLink: "모델 페이지",
    calcLink: "크레딧 계산기",
    compareTick: ["같은 질문을 여러 모델에 묻고 싶다면 답변 비교로", "최대 3개 모델의 답을 나란히 읽습니다."],
    say: "“그래도 난 GPT 6.2 Sol이 좋더라. 이 대화는 그걸로 할래.”",
    selected: "✓ 선택됨",
    choose: "선택",
  },
  continue: {
    eyebrow: "대화 이어가기",
    title: ["다른 AI와 나눈 대화,", "처음부터 다시 설명하지 마세요."],
    body: "각 서비스에서 내보낸 대화 파일을 올리면 질문과 답, 출처가 그대로 Tomverse로 옵니다. 거기서부터 이어서 묻고, 다른 모델의 의견도 들어 보세요.",
    steps: [
      ["내보내기", "쓰던 서비스의 설정에서 대화 데이터를 내려받습니다."],
      ["올리기", "설정 › 데이터 › 대화 가져오기에 파일을 올리면 대화 목록이 정리됩니다."],
      ["이어서 묻기", "고른 대화로 새 대화를 시작해 다음 질문부터 이어갑니다. 가져온 원본은 읽기 전용으로 남습니다."],
    ],
    note: "가져올 수 있는 범위는 서비스별 내보내기 파일 형식에 따라 다릅니다.",
  },
  tools: {
    eyebrow: "대화 안의 도구",
    title: ["자료를 붙이고, 찾고,", "깊게 조사합니다."],
    cards: [
      { k: "파일", h: "문서와 이미지를 그대로", p: "이미지, PDF, Office 문서, 텍스트와 Google Drive 파일을 붙여 묻습니다.", f: "로그인 계정 기준 · 메시지당 10개 · 파일당 50MiB · 총 100MiB" },
      { k: "웹 검색", h: "최신 정보는 웹에서 확인", p: "최신 정보나 출처가 필요한 질문은 웹을 검색해 답합니다. 검색은 켜고 끌 수 있고, 필요해 보이면 실행 전에 제안합니다.", f: "검색이 실제로 실행될 때만 추가 크레딧" },
      { k: "Deep Research", h: "여러 자료를 모아 보고서로", p: "시작 전에 조사 범위를 고르고, 일반 답변과 따로 백그라운드에서 진행됩니다.", f: "Pro 이상 · 크레딧 사용" },
      { k: "이미지", h: "말로 설명하면 그림으로", p: "대화하다가 필요한 이미지를 만들고 이어서 고칩니다.", f: "로그인 필요 · 크레딧 사용" },
    ],
  },
  create: {
    eyebrow: "채팅 · 이미지와 파일",
    title: ["말로 부탁하면,", "만들고 고치고 바꿉니다."],
    body: "그림을 그려 달라고 하면 여러 이미지 모델이 함께 그리고, 사진을 올려 고쳐 달라고 하면 고친 사진이 돌아옵니다. PDF를 합치거나 엑셀을 PDF 표로 바꾸는 일도 채팅 한 줄이면 됩니다.",
    cards: [
      { k: "이미지 생성", h: "한 번 설명하면, 여러 모델이 함께 그립니다", p: "같은 설명으로 여러 이미지 모델의 결과를 나란히 놓고, 마음에 드는 것을 고릅니다." },
      { k: "사진 편집", h: "사진을 올리고, 바꿀 곳만 말하세요", p: "물건 지우기, 배경 바꾸기, 세부 손보기. 고친 사진이 대화 안으로 돌아옵니다." },
      { k: "파일 변환", h: "합치고, 나누고, 형식을 바꿉니다", p: "사진과 PDF를 PDF 하나로, PDF를 여러 개나 이미지로, 엑셀·CSV를 PDF 표로. 바뀐 파일은 채팅에서 바로 내려받습니다." },
    ],
    original: "원본",
    edited: "편집",
    editSay: "“뒤에 지나가는 사람 지워 줘”",
    note: "이미지 생성과 사진 편집은 로그인이 필요하고 크레딧을 씁니다. 쓸 수 있는 이미지 모델은 플랜과 운영 상태에 따라 다릅니다.",
  },
  plugins: {
    eyebrow: "플러그인 · MCP",
    title: ["일하는 곳이 100곳이 넘어도,", "묻는 곳은 한 곳."],
    body: "GitHub, Notion, Slack, Google Drive부터 Linear, Figma, Stripe, Sentry까지 100곳이 넘는 서비스를 연결해 두면, AI가 필요한 자료를 직접 찾아 읽고 답합니다. 탭을 옮겨 다니며 복사해 붙여 넣을 필요가 없습니다.",
    ticks: [
      ["어떤 모델로 대화하든 같은 연결", "특정 회사 모델에 묶이지 않습니다."],
      ["허락할 범위는 직접", "연결할 때 읽기·쓰기를 고르고, 언제든 끊습니다."],
      ["사내 MCP 서버도", "주소만 넣으면 내부 시스템이 대화에 들어옵니다."],
    ],
    connectTitle: "GitHub 연결",
    connectAsk: "무엇을 허락할까요?",
    connected: "연결됨",
    scopes: [["이슈와 PR 읽기", "필요"], ["저장소 코드 읽기", "선택"], ["이슈에 댓글 쓰기", "선택"]],
    customServer: "＋ 사용자 MCP 서버",
    note: "예시 화면입니다. GitHub, Notion, Slack, Google Drive 등 공급자 이름과 로고는 각 소유자의 상표입니다. 사용할 수 있는 공급자는 플랜과 지역에 따라 다를 수 있습니다.",
  },
  keep: {
    eyebrow: "저장 · 공유 · 보호",
    title: ["한 번의 대화를", "다시 쓰는 기록으로."],
    cards: [
      { k: "프로젝트", h: "주제별로 묶고 찾기", p: "대화를 프로젝트로 정리하고 지난 대화를 검색합니다.", f: "계정 필요" },
      { k: "공유", h: "읽기 전용 링크", p: "보내는 순간의 스냅샷만 공유되고, 이후 대화는 보이지 않습니다.", f: "계정 필요" },
      { k: "내보내기", h: "텍스트 파일로 보관", p: "전체 대화 기록을 텍스트 파일로 내려받아 보관합니다.", f: "계정 필요 · 잠긴 대화는 제외" },
      { k: "잠금", h: "민감한 대화는 잠가 두기", p: "잠근 대화는 잠금을 풀기 전에는 공유하거나 파일을 내려받을 수 없습니다.", f: "계정 필요" },
    ],
  },
  mobile: {
    eyebrow: "Android · iOS · 곧 출시",
    title: ["책상에서 시작한 대화,", "주머니에서 마저."],
    body: "같은 계정, 같은 대화 목록. 출근길에 휴대폰으로 시작한 채팅을 자리에 앉아 웹에서 그대로 이어가세요. 사진을 찍어 바로 묻고, 위치가 필요한 질문은 허락한 경우에만 위치를 씁니다.",
    me: "이 메뉴판 사진에서 매운 음식 빼고 추천해 줘",
    ai: "사진에서 7가지 메뉴를 찾았어요. 맵지 않은 메뉴는 두부 요리, 버섯 전골…",
    compose: "메시지 입력",
  },
  cta: {
    title: ["판단이 필요한 질문이라면,", "세 AI에게 같이 물어보세요."],
    body: "같은 질문을 최대 세 모델에 보내고, 차이를 AI Review로 정리합니다.",
    review: "답변 비교 알아보기",
    chat: "채팅 시작하기",
  },
};

const en: ChatPageCopy = {
  crumb: "Chat",
  hero: {
    title: ["Just ask.", "Tomverse picks the model."],
    body: "You don’t have to decide which AI to ask. Tomverse sharpens your question for you and answers with the model that fits it, from {n} providers. If you have a model you like, you can choose it yourself and chat with it.",
    primary: "Start Chat",
    secondary: "Explore models",
    note: "You can start right away, without signing up.",
    motionOff: "Pause animation",
    motionOn: "Resume animation",
  },
  adaptive: {
    eyebrow: "Smart Adaptive",
    title: ["The moment you send,", "three things happen."],
    stepsLabel: "Smart Adaptive steps",
    steps: [
      ["Refines your question", "Sorts out the goal, conditions and priorities"],
      ["Picks a model", "Weighs character, features, quality and cost"],
      ["Answers", "Shows which model answered"],
    ],
    original: "recommend somewhere near seoul for me and my parents this weekend not much walking we have a car",
    refinerChip: "✦ Prompt Refiner · refined automatically",
    refined: "Recommend a day-trip spot near Seoul for me and my parents. We’ll go by car, so somewhere without much walking would be ideal.",
    tags: ["Goal · day trip", "Condition · by car", "Priority · less walking"],
    need: "What this question needs: place suggestions · a text answer · a fast reply",
    credits: "{c} credits",
    chosenCredits: "{c} credit · picked",
    routeNotes: ["For questions that need deep reasoning", "Enough for this question", "For the hardest tasks"],
    answerMeta: "Answered by Gemini Flash-Lite · Smart Adaptive · {c} credit",
    answer: "I picked places about an hour away by car and close to parking. The garden arboretum has short, flat walking paths, and the lakeside café street lets you step out of the car and sit down. Tell me your departure time and where you’d like to eat, and I’ll put it together as a one-day route.",
    followNote: "Follow-up questions are routed the same way again. You can also switch models yourself during a conversation.",
    note: "This is an example screen. The model and credits actually used depend on your question, your plan and your usage.",
  },
  manual: {
    eyebrow: "Choose it yourself",
    title: ["If you have a model", "you like, use that one."],
    body: "Leave it to Tomverse or choose for yourself. You can change it per conversation, so you can start with a familiar model and hear another model’s answer when you need it.",
    creditTick: ["Pick with each model’s base credits for a short request in view", "See credits per model on the {models}, and your monthly usage in the {calc}."],
    modelsLink: "models page",
    calcLink: "credit calculator",
    compareTick: ["To ask several models the same question, use answer comparison", "Read up to 3 models’ answers side by side."],
    say: "“I still like GPT 6.2 Sol. Let’s use it for this conversation.”",
    selected: "✓ Selected",
    choose: "Select",
  },
  continue: {
    eyebrow: "Continue conversations",
    title: ["A conversation you had with another AI?", "Don’t explain it all again."],
    body: "Upload the conversation file exported from each service, and your questions, answers and sources come over to Tomverse as they were. Carry on asking from there, and hear what other models think.",
    steps: [
      ["Export", "Download your conversation data from the service’s settings."],
      ["Upload", "Upload the file under Settings › Data › Import conversations, and your conversation list is organised."],
      ["Keep asking", "Start a new conversation from the one you picked and carry on with your next question. The imported original stays read-only."],
    ],
    note: "What can be imported depends on each service’s export file format.",
  },
  tools: {
    eyebrow: "Tools in the conversation",
    title: ["Attach, search,", "and research in depth."],
    cards: [
      { k: "Files", h: "Documents and images as they are", p: "Attach images, PDFs, Office documents, text and Google Drive files, and ask about them.", f: "Signed-in accounts · 10 per message · 50 MiB per file · 100 MiB total" },
      { k: "Web search", h: "Check recent information on the web", p: "Questions that need recent information or sources are answered with a web search. You can turn search on or off, and when it looks needed Tomverse suggests it before running it.", f: "Extra credits only when a search actually runs" },
      { k: "Deep Research", h: "Gather many sources into a report", p: "Choose the scope before it starts; it runs in the background, separately from ordinary answers.", f: "Pro or above · uses credits" },
      { k: "Images", h: "Describe it, get a picture", p: "Make the image you need during a conversation and keep refining it.", f: "Sign-in required · uses credits" },
    ],
  },
  create: {
    eyebrow: "Chat · Images and files",
    title: ["Ask in words,", "and it makes, fixes and converts."],
    body: "Ask for a picture and several image models draw it together; upload a photo and ask for a fix, and the fixed photo comes back. Merging PDFs or turning a spreadsheet into a PDF table takes one line in the chat.",
    cards: [
      { k: "Image generation", h: "Describe it once, and several models draw it", p: "See results from several image models side by side for the same description, and pick the one you like." },
      { k: "Photo editing", h: "Upload a photo and say only what to change", p: "Remove an object, change the background, touch up details. The edited photo comes back into the conversation." },
      { k: "File conversion", h: "Merge, split and change formats", p: "Photos and PDFs into one PDF, a PDF into several files or images, a spreadsheet or CSV into a PDF table. Download the converted file right in the chat." },
    ],
    original: "Original",
    edited: "Edited",
    editSay: "“Remove the person walking behind”",
    note: "Image generation and photo editing require signing in and use credits. Which image models you can use depends on your plan and service status.",
  },
  plugins: {
    eyebrow: "Plugins · MCP",
    title: ["Even with 100 places you work,", "there is one place you ask."],
    body: "Connect more than 100 services, from GitHub, Notion, Slack and Google Drive to Linear, Figma, Stripe and Sentry, and the AI finds and reads the material it needs and answers. No more hopping between tabs to copy and paste.",
    ticks: [
      ["The same connection with any model", "You aren’t tied to one company’s models."],
      ["You decide what to allow", "Choose read or write access when you connect, and disconnect any time."],
      ["Your company’s MCP server too", "Enter its address and your internal systems join the conversation."],
    ],
    connectTitle: "GitHub connection",
    connectAsk: "What would you like to allow?",
    connected: "Connected",
    scopes: [["Read issues and PRs", "Required"], ["Read repository code", "Optional"], ["Comment on issues", "Optional"]],
    customServer: "＋ Custom MCP server",
    note: "This is an example screen. Provider names and logos such as GitHub, Notion, Slack and Google Drive are trademarks of their owners. Available providers may vary by plan and region.",
  },
  keep: {
    eyebrow: "Save · Share · Protect",
    title: ["Turn one conversation", "into a record you can reuse."],
    cards: [
      { k: "Projects", h: "Group and find by topic", p: "Organise conversations into projects and search your past conversations.", f: "Account required" },
      { k: "Sharing", h: "A read-only link", p: "Only a snapshot from the moment you share is visible; later messages are not.", f: "Account required" },
      { k: "Export", h: "Keep it as text files", p: "Download your whole conversation history as text files for safekeeping.", f: "Account required · locked conversations excluded" },
      { k: "Lock", h: "Lock sensitive conversations", p: "A locked conversation can’t be shared or downloaded until you unlock it.", f: "Account required" },
    ],
  },
  mobile: {
    eyebrow: "Android · iOS · Coming soon",
    title: ["A conversation started at your desk,", "finished in your pocket."],
    body: "The same account and the same conversation list. Start a chat on your phone on the way to work and carry on with it on the web at your desk. Take a photo and ask about it, and location is used only when you allow it.",
    me: "From this menu photo, recommend dishes that aren’t spicy",
    ai: "I found seven dishes in the photo. The ones that aren’t spicy are the tofu dish, the mushroom hot pot…",
    compose: "Message",
  },
  cta: {
    title: ["If a question needs judgement,", "ask three AIs together."],
    body: "Send the same question to up to three models and sort out the differences with AI Review.",
    review: "Learn about answer comparison",
    chat: "Start Chat",
  },
};

export const chatPageContent: Record<Language, ChatPageCopy> = {
  ko,
  en,
  ...chatPageTranslations,
};
