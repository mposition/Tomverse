import type { Language } from "@/lib/language";
import { homeV2Translations } from "./homeV2Content.i18n";

/**
 * Copy for the V2 homepage (approved concept, owner 2026-11-20). Korean is the
 * approved wording; English and the six other locales follow its meaning.
 *
 * `{n}` is replaced with the number of providers in the live public model
 * catalogue (see HomeV2.tsx), so the page never advertises a provider count the
 * catalogue does not have.
 */
export type HomeV2Copy = {
  hero: {
    eyebrow: string;
    title: [string, string];
    body: string;
    primary: string;
    secondary: string;
    note: string;
    threadsMany: string;
    threadsOne: string;
    motionOff: string;
    motionOn: string;
  };
  index: {
    eyebrow: string;
    title: [string, string];
    body: string;
    /** Eight cards, in the order of the sections below. */
    cards: Array<{ k: string; h: string; p: string }>;
  };
  adaptive: {
    eyebrow: string;
    title: [string, string];
    body: string;
    original: string;
    refinerTag: string;
    refined: string;
    changesLabel: string;
    changes: Array<[string, string]>;
    modeLabel: string;
    modeAuto: string;
    modeManual: string;
    autoTitle: string;
    meter: Array<[string, string]>;
    providersLabel: string;
    pick: [string, string];
    manualTitle: string;
    say: string;
    pickerLabel: string;
    otherProviders: string;
    outcome: string;
    note: string;
  };
  continue: {
    eyebrow: string;
    title: [string, string];
    body: string;
    sources: Array<{ name: string; small: string; file: string }>;
    soon: string;
    threadLabel: string;
    threadTitle: string;
    badge: string;
    me: string;
    ai: string;
    imported: Array<["me" | "ai", string]>;
    divider: string;
    followup: string;
    answer: string;
    note: string;
  };
  plugins: {
    eyebrow: string;
    title: [string, string];
    body: string;
    asksLabel: string;
    asks: [string, string, string, string];
    points: Array<[string, string]>;
    customServer: string;
    count: string;
    note: string;
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
  review: {
    eyebrow: string;
    title: [string, string];
    body: string;
    points: Array<[string, string]>;
    videoLabel: string;
    caption: string;
  };
  mobile: {
    eyebrow: string;
    title: [string, string];
    body: string;
    soon: string;
    phoneA: { me: string; ai: string; followup: string; compose: string };
    phoneB: { title: string; count: string; answers: Array<[string, string]>; summary: [string, string]; compose: string };
  };
  api: {
    eyebrow: string;
    title: [string, string];
    body: string;
    toolsLabel: string;
    clients: { codex: string; claude: string; vscode: string; cursor: string; aside: string; otherName: string; other: string };
    facts: Array<[string, string]>;
    note: string;
    console: {
      codexComment: string; codexOk: string;
      claudeFile: string; claudeComment: string; chosenModel: string; claudeOk: string;
      vscodeKeyNote: string; vscodeOk: string;
      cursorOk: string;
      otherFile: string; otherComment: string; otherModelNote: string; otherFormats: string; otherAnthropic: string; otherOk: string;
    };
  };
  cli: {
    eyebrow: string;
    title: [string, string];
    body: string;
    terminalLabel: string;
    steps: Array<[string, string]>;
    term: { ask: string; reading: string; cause: string; diff: string; apply: string; run: string; summary: string };
  };
  plans: {
    eyebrow: string;
    title: string;
    body: string;
    freeNote: string;
    pricingCta: string;
    trustTitle: string;
    trustBody: string;
    safetyCta: string;
  };
  final: {
    title: [string, string];
    body: string;
    chat: string;
    review: string;
  };
};

const ko: HomeV2Copy = {
  hero: {
    eyebrow: "답변 비교 · 공급자 {n}곳",
    title: ["이 답, 믿어도 될까?", "세 AI에게 한 번에."],
    body: "공급자 {n}곳의 AI 가운데 최대 세 개를 골라 같은 질문을 한 번에 보내고, 답을 한 화면에서 나란히 읽으세요. AI Review가 같은 점과 다른 점, 빠진 조건을 원문 인용과 함께 정리하니, 어떤 답을 믿을지 직접 판단할 수 있습니다.",
    primary: "세 AI에 물어보기",
    secondary: "채팅 시작하기",
    note: "가입 없이 바로 비교해 볼 수 있습니다.",
    threadsMany: "Many AIs.",
    threadsOne: "One Tomverse.",
    motionOff: "애니메이션 멈추기",
    motionOn: "애니메이션 다시 재생",
  },
  index: {
    eyebrow: "What Tomverse does",
    title: ["하나의 계정,", "일곱 가지 방법."],
    body: "질문하고, 비교하고, 이어가고, 연결하고, 들고 다니고, 코드까지 맡기세요. 지금 Tomverse에서 쓸 수 있는 기능을 한 화면에 모았습니다.",
    cards: [
      { k: "채팅 · Smart Adaptive", h: "질문에 맞는 모델", p: "질문을 자동으로 다듬고, 기능·품질·비용을 보고 모델을 고릅니다. 직접 골라도 됩니다." },
      { k: "채팅 · 대화 이어가기", h: "하던 대화 그대로", p: "ChatGPT · Claude · Gemini에서 내보낸 대화를 이어갑니다. Perplexity는 곧 지원합니다." },
      { k: "채팅 · 플러그인 · MCP", h: "업무 도구와 연결", p: "GitHub, Notion, Slack, Google Drive부터 직접 등록한 MCP 서버까지." },
      { k: "답변 비교", h: "세 답변, 한 화면", p: "최대 3개 모델의 답을 나란히 읽고 AI Review로 정리합니다." },
      { k: "모바일 · 곧 출시", h: "Android · iOS 앱", p: "같은 대화와 같은 계정을 주머니 속에서." },
      { k: "개발자 · Tomverse API", h: "쓰던 코딩 도구에 연결", p: "Codex, Claude Code, Cursor 등 OpenAI 호환 도구에 API 키 하나로." },
      { k: "개발자 · CLI · 곧 출시", h: "터미널의 코딩 에이전트", p: "내 폴더에서 diff를 제안하고, 승인한 것만 실행합니다." },
      { k: "요금제", h: "필요한 만큼", p: "Free · Pro · Max. 먼저 써 보고, 자주 쓰게 되면 고르세요." },
    ],
  },
  adaptive: {
    eyebrow: "채팅 · Smart Adaptive",
    title: ["질문은 다듬고, 모델은 고르고,", "비용까지 고려합니다."],
    body: "Smart Adaptive는 먼저 Prompt Refiner로 질문을 더 분명하게 다듬고, 질문의 성격과 필요한 기능, 품질·비용 신호를 함께 보고 모델을 고릅니다. 간단한 질문에 늘 같은 고급 모델을 쓸 필요는 없으니까요. 쓰고 싶은 모델이 따로 있다면 직접 골라도 됩니다.",
    original: "평일 하루 30분씩, 2주 동안 영어 단어를 복습하고 싶어. 새 단어보다 이미 배운 단어를 다시 보고 싶어.",
    refinerTag: "✦ Prompt Refiner · 자동으로 다듬음",
    refined: "이미 배운 영어 단어를 복습할 2주 계획을 만들어 줘. 공부할 수 있는 시간은 평일 하루 30분이야. 새 단어보다 기존 단어 복습에 집중해 줘.",
    changesLabel: "자동으로 다듬은 부분",
    changes: [
      ["목적", "원하는 결과(2주 복습 계획)를 맨 앞에"],
      ["조건", "시간 조건(평일 하루 30분)을 따로 정리"],
      ["우선순위", "새 단어보다 복습이 먼저라고 분명하게"],
    ],
    modeLabel: "모델 선택 방식",
    modeAuto: "Smart Adaptive",
    modeManual: "직접 선택",
    autoTitle: "이 질문에 맞게, 모델을 고릅니다.",
    meter: [["질문의 성격", "계획"], ["필요한 기능", "텍스트"], ["품질 신호", "높음"], ["예상 비용", "낮음"]],
    providersLabel: "공급자 {n}곳의 모델 중에서",
    pick: ["이번 질문은", "모델로"],
    manualTitle: "쓰고 싶은 모델이 있다면, 그대로.",
    say: "“그래도 난 GPT 6.2 Sol이 좋더라. 이 대화는 그걸로 할래.”",
    pickerLabel: "모델 선택 예시",
    otherProviders: "다른 공급자 모델",
    outcome: "자동으로 맡기거나, 직접 고르거나. 대화마다 바꿀 수 있습니다.",
    note: "실제 비용과 답변 품질은 선택된 모델, 질문과 사용량에 따라 달라집니다. 예시의 선택 결과는 설명용이며, 쓸 수 있는 모델은 플랜에 따라 다릅니다.",
  },
  continue: {
    eyebrow: "채팅 · 대화 이어가기",
    title: ["다른 AI에서 하던 대화,", "여기서 이어가세요."],
    body: "각 서비스에서 내보낸 대화 파일을 올리면 맥락이 그대로 Tomverse로 옵니다. 처음부터 다시 설명할 필요 없이 다음 질문부터 시작하세요. 출처와 인용도 함께 남습니다.",
    sources: [
      { name: "ChatGPT", small: "데이터 내보내기 파일", file: "conversations.json" },
      { name: "Claude", small: "계정 데이터 내보내기", file: "claude-export.zip" },
      { name: "Gemini", small: "Google 테이크아웃", file: "takeout.zip" },
      { name: "Perplexity", small: "스레드 Markdown 내보내기", file: "" },
    ],
    soon: "곧 지원",
    threadLabel: "이어간 대화 예시",
    threadTitle: "제주 3박 4일 일정",
    badge: "ChatGPT에서 가져옴 · 24개 메시지",
    me: "나",
    ai: "AI",
    imported: [
      ["me", "부모님과 제주 3박 4일, 많이 걷지 않는 일정으로 짜줘."],
      ["ai", "동선을 줄이기 위해 첫날은 공항 근처 서쪽, 둘째 날은 중문 위주로…"],
      ["me", "둘째 날 비 오면 실내 일정으로 바꿔줘."],
    ],
    divider: "Tomverse에서 이어서",
    followup: "숙소를 서귀포로 정했어. 이걸 반영해서 셋째 날을 다시 짜줘.",
    answer: "앞에서 정한 “많이 걷지 않기”와 “비 오는 날 실내 대안”을 유지할게요. 서귀포 숙소 기준으로 셋째 날은 이동을 30분 이내로 묶어…",
    note: "제품 이해를 위한 예시 화면입니다. 지원 형식과 가져올 수 있는 범위는 서비스별 내보내기 파일에 따라 다릅니다.",
  },
  plugins: {
    eyebrow: "채팅 · 플러그인 · MCP",
    title: ["일하는 곳이 100곳이 넘어도,", "묻는 곳은 한 곳."],
    body: "GitHub, Notion, Slack, Google Drive부터 Linear, Figma, Stripe, Sentry까지 100곳이 넘는 서비스를 연결해 두면, AI가 필요한 자료를 직접 찾아 읽고 답합니다. 탭을 옮겨 다니며 복사해 붙여 넣을 필요도, 오래된 발췌로 답을 받을 일도 없습니다.",
    asksLabel: "연결하면 이렇게 묻습니다",
    asks: [
      "“어제 올라온 GitHub 이슈 중 결제 관련만 요약해 줘”",
      "“Notion 회의록에서 이번 주 내 할 일만 뽑아 줘”",
      "“Slack #support에서 자주 나온 질문 정리해 줘”",
      "“Sentry 오류와 관련 PR을 묶어서 보여 줘”",
    ],
    points: [
      ["복사·붙여넣기 없이", "이슈, 문서, 대화를 AI가 직접 열어 지금 내용으로 답합니다."],
      ["어떤 모델과도", "한 번 연결하면 Smart Adaptive가 고른 모델이든 직접 고른 모델이든 함께 씁니다. 한 회사 모델에 묶이지 않습니다."],
      ["권한은 내가", "연결할 때 읽기·쓰기 범위를 고르고, 언제든 연결을 끊습니다."],
      ["사내 시스템까지", "목록에 없어도 MCP 서버 주소만 넣으면 회사 내부 도구가 대화에 들어옵니다."],
    ],
    customServer: "＋ 사용자 MCP 서버",
    count: "연결 가능한 서비스 100곳 이상 · 계속 늘어납니다",
    note: "GitHub, Notion, Slack, Google Drive 등 공급자 이름과 로고는 각 소유자의 상표입니다. 사용할 수 있는 공급자는 플랜과 지역에 따라 다를 수 있습니다.",
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
  review: {
    eyebrow: "답변 비교 · Tomverse Review",
    title: ["같은 질문. 다른 시선.", "비교는 더 깊게."],
    body: "최대 3개 모델의 답변을 나란히 읽고, AI Review로 공통점·차이·빠진 조건을 인용과 함께 살펴보세요. 더 읽을 답변과 다음 질문은 직접 고릅니다.",
    points: [
      ["최대 3개 모델", "같은 질문을 한 번에 묻고 답을 나란히 읽습니다."],
      ["AI Review", "공통점, 관점 차이, 빠진 조건을 정리합니다."],
      ["인용으로 확인", "정리한 내용마다 어느 답변의 어느 문장인지 짚어 줍니다."],
    ],
    videoLabel: "답변 비교 실제 화면: 질문을 세 모델에 보내고 AI Review로 정리하는 과정",
    caption: "실제 Tomverse Review 화면을 시연용 데이터로 녹화했습니다. 노트북은 가상의 제품이고, 모델 답변과 분석은 예시입니다.",
  },
  mobile: {
    eyebrow: "Android · iOS · 곧 출시",
    title: ["책상에서 시작한 대화,", "주머니에서 마저."],
    body: "같은 계정, 같은 대화 목록. 출근길에 휴대폰으로 시작한 채팅을 자리에 앉아 웹에서 그대로 이어가세요. 판단이 필요한 질문은 그 자리에서 세 AI의 답을 나란히 비교할 수 있습니다. 사진을 찍어 바로 묻고, 위치가 필요한 질문은 허락한 경우에만 위치를 씁니다.",
    soon: "곧 출시",
    phoneA: {
      me: "이 메뉴판 사진에서 매운 음식 빼고 추천해 줘",
      ai: "사진에서 7가지 메뉴를 찾았어요. 맵지 않은 메뉴는 두부 요리, 버섯 전골, 계란말이…",
      followup: "부모님 두 분이 나눠 먹기 좋은 걸로",
      compose: "메시지 입력",
    },
    phoneB: {
      title: "Review",
      count: "3개 답변",
      answers: [["A · 무게 우선", "가벼운 A를 먼저 살펴보세요."], ["B · RAM 우선", "여러 작업이면 B를 비교하세요."], ["C · 빠진 조건", "배터리와 화면도 확인하세요."]],
      summary: ["AI Review", "기준의 차이일 뿐, 사실 모순은 없습니다."],
      compose: "다음 질문",
    },
  },
  api: {
    eyebrow: "개발자 · Tomverse API",
    title: ["쓰던 코딩 도구에,", "Tomverse API 키 하나."],
    body: "공급사마다 따로 가입하고 결제할 필요 없이, 쓰던 코딩 도구에서 공급자 {n}곳의 모델을 씁니다. Smart Adaptive가 가벼운 요청은 가벼운 모델로 보내 크레딧을 아끼고, 키마다 걸어 둔 한도를 넘지 않습니다. 표준 OpenAI 호환 API를 쓰는 도구라면 모두 연결됩니다(Pro 이상).",
    toolsLabel: "연결할 도구",
    clients: {
      codex: "터미널 · VS Code 확장",
      claude: "터미널 · VS Code 확장",
      vscode: "Copilot 사용자 지정 엔드포인트",
      cursor: "Chat · Agent",
      aside: "Custom Provider",
      otherName: "OpenAI 호환 도구",
      other: "Base URL과 키만 바꾸면 연결",
    },
    facts: [["OpenAI 호환", "https://tomverse.app/api/v1"], ["Anthropic 호환", "https://tomverse.app/api/anthropic"], ["API 키", "설정 > API 키 · 키별 크레딧 한도"]],
    note: "설정 > API 키 화면이 만들어 주는 설정을 줄여 보여 줍니다. 실제 값은 고른 모델과 새로 만든 키로 채워집니다. 목록에 없는 도구는 OpenAI 호환 API(Chat Completions·Responses)를 지원해야 연결됩니다.",
    console: {
      codexComment: "# Tomverse 공급자 추가 (기본 설정은 그대로)",
      codexOk: "✓ Tomverse 모델로 실행 중",
      claudeFile: "macOS / Linux 터미널",
      claudeComment: "# Claude Code를 Tomverse로",
      chosenModel: "<고른 모델>",
      claudeOk: "✓ Tomverse 계정의 모델로 실행 중",
      vscodeKeyNote: "# 키는 VS Code가 한 번 묻고 안전하게 보관합니다",
      vscodeOk: "✓ Copilot 채팅에서 Tomverse 모델 선택",
      cursorOk: "✓ Chat · Agent에서 사용 가능",
      otherFile: "OpenAI 호환 도구 · 공통 설정",
      otherComment: "# 도구의 OpenAI 호환(사용자 지정) 공급자 설정에",
      otherModelNote: "  # 또는 계정에서 쓸 수 있는 모델 ID",
      otherFormats: "# 지원 형식: Chat Completions · Responses",
      otherAnthropic: "# Anthropic 형식 도구는 /api/anthropic",
      otherOk: "✓ 표준 OpenAI API를 쓰는 도구라면 연결 가능",
    },
  },
  cli: {
    eyebrow: "개발자 · Tomverse CLI · 곧 출시",
    title: ["터미널에서 바로,", "내 폴더의 코딩 에이전트."],
    body: "Claude Code나 Codex 없이도 Tomverse API 키 하나로 동작합니다. 코드를 읽고 diff를 제안하고, 승인한 명령만 실행한 뒤 무엇을 했고 얼마가 들었는지 알려 줍니다.",
    terminalLabel: "Tomverse CLI 실행 예시",
    steps: [
      ["읽고 계획합니다", "현재 폴더의 코드만 읽습니다. 키는 설정·세션·로그 어디에도 쓰지 않습니다."],
      ["diff로 제안합니다", "바꿀 내용을 먼저 보여 주고, 승인한 변경만 적용합니다."],
      ["승인한 명령만 실행합니다", "테스트와 빌드도 매번 묻습니다. 저장소 안의 어떤 파일도 권한을 바꿀 수 없습니다."],
      ["한 일과 비용을 보고합니다", "끝나면 변경 파일, 실행한 명령, 사용한 크레딧을 요약합니다."],
    ],
    term: {
      ask: "mul 함수가 음수에서 틀려. 고치고 테스트까지 돌려 줘",
      reading: "● src/mul.js, test.js 읽는 중…",
      cause: "● 원인: 부호 처리 없이 반복 덧셈 사용",
      diff: "제안 diff · src/mul.js",
      apply: "적용할까요?",
      run: "실행할까요?",
      summary: "요약  파일 1개 변경 · 명령 1회 실행 · 3 크레딧",
    },
  },
  plans: {
    eyebrow: "Free · Pro · Max",
    title: "필요한 만큼 시작하세요.",
    body: "모델별 할당량도, 5시간·주간 단위로 끊기는 사용 제한도 없습니다. 매달 받는 크레딧 하나로 어떤 모델이든 씁니다. 먼저 무료로 써 보고, 자주 쓰게 될 때 플랜을 고르세요.",
    freeNote: "Free는 하루 30크레딧과 고비용 모델 월 30회 한도가 있습니다. 비정상 사용을 막는 운영 안전장치는 모든 플랜에 적용됩니다.",
    pricingCta: "요금제 살펴보기",
    trustTitle: "내 자료가 어디로 가는지도, 분명하게.",
    trustBody: "선택한 AI 제공자가 답변에 필요한 내용을 처리합니다. 데이터 처리 범위와 잠금·공유 기능은 안전 페이지에서 확인하세요.",
    safetyCta: "안전 · 데이터 처리",
  },
  final: {
    title: ["가입 없이,", "첫 질문부터."],
    body: "궁금한 내용을 Chat에 물어보거나, Review에서 여러 모델의 관점을 비교해 보세요. 직접 써 본 뒤 나에게 맞는 방식과 플랜을 고르면 됩니다.",
    chat: "채팅 시작하기",
    review: "답변 비교 시작하기",
  },
};

const en: HomeV2Copy = {
  hero: {
    eyebrow: "Answer comparison · {n} providers",
    title: ["Can you trust this answer?", "Ask three AIs at once."],
    body: "Pick up to three AIs from {n} providers, send them the same question at once and read the answers side by side. AI Review lays out what they agree on, where they differ and what they left out, quoting each answer, so you can decide which one to trust.",
    primary: "Ask three AIs",
    secondary: "Start a chat",
    note: "Compare right away, no sign-up needed.",
    threadsMany: "Many AIs.",
    threadsOne: "One Tomverse.",
    motionOff: "Pause animation",
    motionOn: "Resume animation",
  },
  index: {
    eyebrow: "What Tomverse does",
    title: ["One account,", "seven ways to use it."],
    body: "Ask, compare, continue, connect, take it with you, and hand it code. Everything you can do in Tomverse today, on one screen.",
    cards: [
      { k: "Chat · Smart Adaptive", h: "The right model for the question", p: "Refines your question, then picks a model by capability, quality and cost. Or pick one yourself." },
      { k: "Chat · Continue a conversation", h: "Pick up where you left off", p: "Continue conversations exported from ChatGPT, Claude and Gemini. Perplexity is coming soon." },
      { k: "Chat · Plugins · MCP", h: "Connect your work tools", p: "From GitHub, Notion, Slack and Google Drive to MCP servers you register yourself." },
      { k: "Answer comparison", h: "Three answers, one screen", p: "Read up to three models' answers side by side and sum them up with AI Review." },
      { k: "Mobile · Coming soon", h: "Android and iOS apps", p: "The same conversations and the same account, in your pocket." },
      { k: "Developers · Tomverse API", h: "Plug into your coding tools", p: "Codex, Claude Code, Cursor and other OpenAI-compatible tools, with one API key." },
      { k: "Developers · CLI · Coming soon", h: "A coding agent in your terminal", p: "Proposes diffs in your folder and runs only what you approve." },
      { k: "Plans", h: "As much as you need", p: "Free · Pro · Max. Try it first, choose a plan once you use it often." },
    ],
  },
  adaptive: {
    eyebrow: "Chat · Smart Adaptive",
    title: ["It sharpens the question, picks the model", "and keeps cost in mind."],
    body: "Smart Adaptive first sharpens your question with Prompt Refiner, then picks a model from the kind of question, the features it needs and quality and cost signals. A simple question does not need the same premium model every time. If you have a model you prefer, pick it yourself.",
    original: "I want to review English words for 30 minutes on weekdays for two weeks. More review of words I already know than new ones.",
    refinerTag: "✦ Prompt Refiner · refined automatically",
    refined: "Make a two-week plan to review English words I have already learned. I can study 30 minutes a day on weekdays. Focus on reviewing known words rather than new ones.",
    changesLabel: "What was refined",
    changes: [
      ["Goal", "The result you want (a two-week review plan) comes first"],
      ["Constraint", "The time limit (30 minutes on weekdays) stands on its own"],
      ["Priority", "Makes clear that review comes before new words"],
    ],
    modeLabel: "How the model is chosen",
    modeAuto: "Smart Adaptive",
    modeManual: "Choose yourself",
    autoTitle: "It picks a model to fit this question.",
    meter: [["Kind of question", "Planning"], ["Features needed", "Text"], ["Quality signal", "High"], ["Expected cost", "Low"]],
    providersLabel: "From models across {n} providers",
    pick: ["This question goes to", ""],
    manualTitle: "If you have a model in mind, use it.",
    say: "“I still like GPT 6.2 Sol. I’ll use it for this chat.”",
    pickerLabel: "Model picker example",
    otherProviders: "Models from other providers",
    outcome: "Leave it to Smart Adaptive or choose yourself. You can switch for every conversation.",
    note: "Actual cost and answer quality depend on the model chosen, the question and usage. The selection shown is an illustration, and the models you can use depend on your plan.",
  },
  continue: {
    eyebrow: "Chat · Continue a conversation",
    title: ["The conversation you started elsewhere,", "continue it here."],
    body: "Upload the conversation file exported from each service and the context comes with it. No need to explain everything again: start from your next question. Sources and quotes come along too.",
    sources: [
      { name: "ChatGPT", small: "Data export file", file: "conversations.json" },
      { name: "Claude", small: "Account data export", file: "claude-export.zip" },
      { name: "Gemini", small: "Google Takeout", file: "takeout.zip" },
      { name: "Perplexity", small: "Thread Markdown export", file: "" },
    ],
    soon: "Coming soon",
    threadLabel: "Example of a continued conversation",
    threadTitle: "Four days in Jeju",
    badge: "Imported from ChatGPT · 24 messages",
    me: "Me",
    ai: "AI",
    imported: [
      ["me", "Plan four days in Jeju with my parents, without much walking."],
      ["ai", "To keep travel short, day one stays on the west side near the airport, day two around Jungmun…"],
      ["me", "If it rains on day two, switch to indoor plans."],
    ],
    divider: "Continued in Tomverse",
    followup: "We booked a place in Seogwipo. Redo day three with that in mind.",
    answer: "I’ll keep “not much walking” and “indoor options for rain” from earlier. From Seogwipo, day three keeps every move under 30 minutes…",
    note: "An example screen to explain the product. Supported formats and what can be imported depend on each service’s export file.",
  },
  plugins: {
    eyebrow: "Chat · Plugins · MCP",
    title: ["Work in a hundred places,", "ask in one."],
    body: "Connect more than 100 services, from GitHub, Notion, Slack and Google Drive to Linear, Figma, Stripe and Sentry, and the AI finds and reads what it needs before it answers. No hopping between tabs to copy and paste, no answers built on stale excerpts.",
    asksLabel: "Once connected, you can ask",
    asks: [
      "“Summarise only the payment-related GitHub issues opened yesterday”",
      "“Pull my to-dos for this week out of the Notion meeting notes”",
      "“List the questions that came up most in Slack #support”",
      "“Group the Sentry errors with the PRs related to them”",
    ],
    points: [
      ["No copy and paste", "The AI opens the issue, document or thread itself and answers from what is there now."],
      ["With any model", "Connect once and use it with the model Smart Adaptive picks or the one you choose. You are not tied to one company’s models."],
      ["You set the access", "Choose read and write scopes when you connect, and disconnect at any time."],
      ["Your own systems too", "Not in the list? Add an MCP server address and your internal tools join the conversation."],
    ],
    customServer: "＋ Your own MCP server",
    count: "More than 100 services to connect · and growing",
    note: "GitHub, Notion, Slack, Google Drive and other names and logos are trademarks of their owners. Available providers can vary by plan and region.",
  },
  create: {
    eyebrow: "Chat · Images and files",
    title: ["Just ask, and it makes,", "fixes and converts."],
    body: "Ask for a picture and several image models draw it together. Upload a photo and say what to fix, and the edited photo comes back. Merging PDFs or turning a spreadsheet into a PDF table takes one line in the chat.",
    cards: [
      { k: "Image generation", h: "Describe it once, several models draw it", p: "Put the results of several image models for the same description side by side and keep the one you like." },
      { k: "Photo editing", h: "Upload a photo and say what to change", p: "Remove objects, change the background, touch up details. The edited photo comes back into the conversation." },
      { k: "File conversion", h: "Merge, split and change formats", p: "Photos and PDFs into one PDF, a PDF into several files or images, Excel and CSV into a PDF table. Download the result right from the chat." },
    ],
    original: "Original",
    edited: "Edited",
    editSay: "“Remove the person walking behind”",
    note: "Image generation and photo editing need you to sign in and use credits. The image models you can use depend on your plan and on service status.",
  },
  review: {
    eyebrow: "Answer comparison · Tomverse Review",
    title: ["Same question. Different views.", "Compare more deeply."],
    body: "Read up to three models’ answers side by side and use AI Review to see what they share, where they differ and what they left out, with quotes. You choose which answer to read further and what to ask next.",
    points: [
      ["Up to three models", "Ask the same question at once and read the answers side by side."],
      ["AI Review", "Lays out agreement, differences in view and missing conditions."],
      ["Check the quotes", "Every point shows which sentence of which answer it comes from."],
    ],
    videoLabel: "The real answer comparison screen: a question sent to three models and summed up with AI Review",
    caption: "Recorded on the real Tomverse Review screen with demo data. The laptops are fictional products, and the model answers and analysis are examples.",
  },
  mobile: {
    eyebrow: "Android · iOS · Coming soon",
    title: ["Start at your desk,", "finish on the go."],
    body: "The same account and the same conversation list. Start a chat on your phone on the way to work and continue it on the web at your desk. When a question needs judgement, compare three AIs’ answers right there. Take a photo and ask about it, and location is used only when you allow it.",
    soon: "Coming soon",
    phoneA: {
      me: "From this menu photo, recommend dishes that aren’t spicy",
      ai: "I found seven dishes in the photo. The ones that aren’t spicy are the tofu dish, the mushroom hot pot, the rolled omelette…",
      followup: "Something my parents can share",
      compose: "Message",
    },
    phoneB: {
      title: "Review",
      count: "3 answers",
      answers: [["A · Weight first", "Look at the lighter A first."], ["B · RAM first", "For multitasking, compare B."], ["C · Missing conditions", "Check battery and screen too."]],
      summary: ["AI Review", "A difference in criteria, not a factual contradiction."],
      compose: "Next question",
    },
  },
  api: {
    eyebrow: "Developers · Tomverse API",
    title: ["The coding tools you already use,", "one Tomverse API key."],
    body: "Use models from {n} providers in the coding tools you already use, without signing up and paying for each provider. Smart Adaptive sends light requests to light models to save credits, and every key stays within the limit you set for it. Any tool that uses the standard OpenAI-compatible API can connect (Pro and above).",
    toolsLabel: "Tool to connect",
    clients: {
      codex: "Terminal · VS Code extension",
      claude: "Terminal · VS Code extension",
      vscode: "Copilot custom endpoint",
      cursor: "Chat · Agent",
      aside: "Custom Provider",
      otherName: "OpenAI-compatible tools",
      other: "Change the base URL and key to connect",
    },
    facts: [["OpenAI-compatible", "https://tomverse.app/api/v1"], ["Anthropic-compatible", "https://tomverse.app/api/anthropic"], ["API keys", "Settings > API keys · a credit limit per key"]],
    note: "A shortened version of the settings that Settings > API keys generates. The real values are filled in with the model you choose and a new key. Tools not listed need to support the OpenAI-compatible API (Chat Completions or Responses) to connect.",
    console: {
      codexComment: "# Add Tomverse as a provider (your defaults stay as they are)",
      codexOk: "✓ Running on Tomverse models",
      claudeFile: "macOS / Linux terminal",
      claudeComment: "# Point Claude Code at Tomverse",
      chosenModel: "<model you chose>",
      claudeOk: "✓ Running on your Tomverse account’s models",
      vscodeKeyNote: "# VS Code asks for the key once and stores it securely",
      vscodeOk: "✓ Pick Tomverse models in Copilot chat",
      cursorOk: "✓ Available in Chat and Agent",
      otherFile: "OpenAI-compatible tools · common settings",
      otherComment: "# In the tool’s OpenAI-compatible (custom) provider settings",
      otherModelNote: "  # or any model ID your account can use",
      otherFormats: "# Supported: Chat Completions · Responses",
      otherAnthropic: "# Anthropic-format tools use /api/anthropic",
      otherOk: "✓ Any tool on the standard OpenAI API can connect",
    },
  },
  cli: {
    eyebrow: "Developers · Tomverse CLI · Coming soon",
    title: ["Right in your terminal,", "a coding agent for your folder."],
    body: "Works with one Tomverse API key, no Claude Code or Codex needed. It reads the code, proposes a diff, runs only the commands you approve, then tells you what it did and what it cost.",
    terminalLabel: "Example Tomverse CLI session",
    steps: [
      ["Reads and plans", "Reads only the code in the current folder. The key is never written to settings, sessions or logs."],
      ["Proposes a diff", "Shows the change first and applies only what you approve."],
      ["Runs only approved commands", "Asks every time, tests and builds included. No file in the repository can change its permissions."],
      ["Reports work and cost", "When it finishes, it sums up the files changed, the commands run and the credits used."],
    ],
    term: {
      ask: "mul is wrong for negative numbers. Fix it and run the tests",
      reading: "● Reading src/mul.js, test.js…",
      cause: "● Cause: repeated addition with no sign handling",
      diff: "Proposed diff · src/mul.js",
      apply: "Apply it?",
      run: "Run it?",
      summary: "Summary  1 file changed · 1 command run · 3 credits",
    },
  },
  plans: {
    eyebrow: "Free · Pro · Max",
    title: "Start with as much as you need.",
    body: "No per-model quotas and no limits that cut you off every five hours or every week. One monthly credit balance works with any model. Try it free first and choose a plan once you use it often.",
    freeNote: "Free has a limit of 30 credits a day and 30 premium-model requests a month. Operational safeguards against abnormal use apply to every plan.",
    pricingCta: "See plans",
    trustTitle: "Where your data goes, made clear.",
    trustBody: "The AI provider you choose processes what it needs to answer. See the safety page for how data is handled and how locking and sharing work.",
    safetyCta: "Safety and data",
  },
  final: {
    title: ["No sign-up.", "Start with your first question."],
    body: "Ask Chat what you want to know, or compare several models’ views in Review. Try it yourself, then pick the way of working and the plan that suit you.",
    chat: "Start a chat",
    review: "Start comparing answers",
  },
};

export const homeV2Content: Record<Language, HomeV2Copy> = { ko, en, ...homeV2Translations };
export const homeV2SourceCopy = { ko, en };
