import type { Language } from "@/lib/language";
import { developersPageTranslations } from "./developersPageContent.i18n";

/**
 * Copy for the developer page (approved concept, owner 2026-11-20). Korean is the
 * approved wording, corrected where the code or docs/policy/external-api.md says
 * otherwise; English and the six other locales follow its meaning.
 *
 * `{n}` is replaced with the number of providers in the live public model
 * catalogue, so the page never advertises a provider count the catalogue does not
 * have. The tool tabs, the console text and the CLI session reuse the homepage's
 * copy (homeV2Content), so they are not repeated here.
 */
export type DevelopersPageCopy = {
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
  why: {
    eyebrow: string;
    title: [string, string];
    cards: Array<{ k: string; h: string; p: string }>;
  };
  adaptive: {
    eyebrow: string;
    title: [string, string];
    /** Text around the three inline code names: smart-adaptive, model, x-tomverse-routed-model. */
    body: [string, string, string, string];
    savingLabels: [string, string];
    savingNote: string;
    routeAsks: [string, string, string, string, string];
    tiers: { light: string; mid: string; high: string };
    routeNote: string;
  };
  connect: {
    eyebrow: string;
    title: [string, string];
    note: string;
    /** Link to the Cursor connection guide (/developers/cursor). */
    cursorGuide: string;
  };
  proto: {
    eyebrow: string;
    title: [string, string];
    descriptions: [string, string, string];
    flowTool: [string, string];
    flowApi: [string, string];
    flowProviders: [string, string];
    privacy: string;
  };
  keys: {
    eyebrow: string;
    title: [string, string];
    ticks: Array<[string, string]>;
    chipActive: string;
    chipRevoked: string;
    capLabel: string;
    capAria: string;
    used: string;
    revoke: string;
    reset: string;
    demoNote: string;
  };
  cli: {
    eyebrow: string;
    title: [string, string];
    body: string;
    cta: string;
  };
  faq: {
    eyebrow: string;
    title: string;
    /** `{safety}` and `{models}` stand for the safety-page link and the models endpoint. */
    safetyLink: string;
    items: Array<{ q: string; a: string }>;
  };
  cta: {
    title: [string, string];
    body: string;
    primary: string;
    secondary: string;
  };
};

const ko: DevelopersPageCopy = {
  crumb: "개발자",
  hero: {
    title: ["쓰던 코딩 도구는 그대로.", "모델은 {n}곳에서 고르세요."],
    body: "Tomverse API 키 하나로 Codex, Claude Code, Cursor, VS Code, Aside를 연결합니다. Cursor, VS Code, Aside에서는 공급자 {n}곳의 모델을 고르고, Codex는 OpenAI 모델, Claude Code는 Anthropic 모델로 동작합니다. 모든 요청에 가장 비싼 모델을 쓸 필요는 없습니다. 스마트 자동(Smart Adaptive)이 요청마다 알맞은 모델을 고르고, 키에 한도를 걸어 두면 그 한도를 넘지 않습니다.",
    primary: "API 키 만들기",
    secondary: "도구별 연결 방법",
    note: "Pro 이상 플랜에서 쓸 수 있고, 채팅과 같은 크레딧을 씁니다.",
    motionOff: "애니메이션 멈추기",
    motionOn: "애니메이션 다시 재생",
  },
  why: {
    eyebrow: "왜 Tomverse를 연결하나요",
    title: ["공급사마다 따로 가입하고,", "키마다 따로 결제하던 일을 하나로."],
    cards: [
      { k: "모델 선택", h: "도구는 그대로, 모델은 {n}곳에서", p: "OpenAI, Anthropic, Google, xAI, DeepSeek 등 공급자 {n}곳의 모델을 키 하나로 바꿔 가며 씁니다. 한 회사 구독은 해 줄 수 없는 일입니다. Codex는 OpenAI 모델, Claude Code는 Anthropic 모델 안에서 고릅니다." },
      { k: "스마트 자동(Smart Adaptive)", h: "비싼 모델은 필요할 때만", p: "가벼운 요청은 가벼운 모델이, 설계와 디버깅은 고급 모델이 맡습니다. 어느 모델이 답했는지 응답마다 함께 돌아옵니다." },
      { k: "예산", h: "정해 둔 만큼만 나갑니다", p: "키마다 크레딧 한도를 걸고, 프로젝트나 CI별로 키를 나눕니다. 한도를 넘어 크레딧이 나가지 않고, 키는 언제든 즉시 폐기할 수 있습니다." },
      { k: "하나의 계정", h: "비교해 보고, 그 모델로 코딩", p: "이 코드 문제에 어떤 모델이 맞는지 답변 비교로 먼저 견줘 보고, 고른 모델을 그대로 코딩 도구에 넣습니다." },
    ],
  },
  adaptive: {
    eyebrow: "스마트 자동(Smart Adaptive)",
    title: ["모든 요청에 가장 비싼", "모델이 필요하진 않습니다."],
    body: [
      "모델 이름에 ",
      "만 넣으세요. 이름 짓기와 간단한 수정은 가벼운 모델이, 구조 설계와 까다로운 버그는 고급 모델이 맡습니다. 응답의 ",
      " 필드와 ",
      " 헤더에 실제로 답한 모델이 적혀 옵니다. Codex에서는 OpenAI 모델 안에서, Claude Code에서는 Anthropic 모델 안에서 고릅니다.",
    ],
    savingLabels: ["스마트 자동", "전부 고급 모델"],
    savingNote: "오른쪽 요청 다섯 개 기준 크레딧 합계 예시입니다.",
    routeAsks: ["변수 이름을 의미 있게 바꿔 줘", "이 함수에 타입 주석 달아 줘", "테스트가 가끔 실패하는 원인 찾아 줘", "README 설치 절차 다듬어 줘", "결제 모듈을 두 서비스로 나누는 설계"],
    tiers: { light: "가벼운 모델", mid: "중간 모델", high: "고급 모델" },
    routeNote: "예시입니다. 실제 선택과 크레딧은 요청 내용, 문맥 길이, 플랜에 따라 달라집니다.",
  },
  connect: {
    eyebrow: "도구별 연결",
    title: ["설정 › API 키에서 도구를 고르면", "붙여 넣을 설정이 바로 나옵니다."],
    note: "설정 › API 키 화면이 만들어 주는 설정을 줄여 보여 줍니다. 실제 값은 고른 모델과 새로 만든 키로 채워집니다. Cursor의 Tab과 Cursor 자체 모델은 이 키를 쓰지 않습니다.",
    cursorGuide: "Cursor 자세한 연결 안내",
  },
  proto: {
    eyebrow: "지원하는 방식",
    title: ["세 가지 표준 방식,", "하나의 키."],
    descriptions: [
      "Cursor, Aside, VS Code와 대부분의 OpenAI 호환 도구. 스트리밍과 함수 도구 호출을 지원하고, 공급자 {n}곳의 모델을 모두 씁니다.",
      "Codex 터미널과 IDE 확장. OpenAI 모델을 씁니다.",
      "Claude Code 터미널과 VS Code 확장. Anthropic 모델을 씁니다.",
    ],
    flowTool: ["내 코딩 도구", "에이전트와 도구 실행은 여기서"],
    flowApi: ["Tomverse API", "키 확인 · 모델 선택 · 크레딧 정산"],
    flowProviders: ["공급자 {n}곳", "OpenAI · Anthropic · Google …"],
    privacy: "Tomverse API는 요청을 받아 모델에 전달하고 결과를 돌려주는 통로입니다. 요청에 담긴 코드와 모델의 답변은 저장하지 않습니다. 파일을 고치거나 명령을 실행하는 일은 내 도구 안에서만 일어나고, Tomverse 서버는 도구를 대신 실행하지 않습니다.",
  },
  keys: {
    eyebrow: "키와 한도",
    title: ["키는 쓰임새마다 나누고,", "한도는 키마다."],
    ticks: [
      ["Pro 이상 플랜", "Free 계정은 API 키를 만들 수 없습니다."],
      ["계정당 키 10개까지", "개인 작업, 팀 프로젝트, CI를 서로 다른 키로 나눕니다."],
      ["키마다 크레딧 한도를 걸 수 있습니다", "한도는 그 키가 쓴 크레딧의 누적 합계에 걸리고, 닿으면 그 키만 멈춥니다. 다른 키와 채팅은 그대로입니다."],
      ["즉시 폐기", "폐기는 언제나 동작합니다. 키가 할 수 있는 일은 모델 호출, 모델 목록, 자기 사용량 조회뿐입니다."],
      ["크레딧은 채팅과 공유", "플랜 크레딧과 추가 구매 크레딧에서 함께 차감됩니다."],
    ],
    chipActive: "사용 중",
    chipRevoked: "폐기됨",
    capLabel: "이 키의 크레딧 한도",
    capAria: "크레딧 한도",
    used: "사용 {used} / {cap} 크레딧",
    revoke: "키 폐기",
    reset: "예시 되돌리기",
    demoNote: "예시 화면입니다. 실제 키는 설정 › API 키에서 만듭니다.",
  },
  cli: {
    eyebrow: "Tomverse CLI",
    title: ["도구가 없어도,", "터미널 하나면 됩니다."],
    body: "Tomverse API 키만 있으면 내 폴더에서 동작하는 코딩 에이전트입니다. 코드를 읽고 diff를 제안하고, 승인한 명령만 실행한 뒤 무엇을 했고 얼마가 들었는지 알려 줍니다. Windows는 .msi나 winget, macOS는 .pkg, Linux는 .deb·.rpm 설치 프로그램으로 설치하고, Node.js가 있으면 npm으로도 설치합니다.",
    cta: "CLI 설치 안내 보기",
  },
  faq: {
    eyebrow: "자주 묻는 질문",
    title: "연결하기 전에.",
    safetyLink: "안전 페이지",
    items: [
      { q: "내 코드가 Tomverse에 저장되나요?", a: "아니요. Tomverse는 요청에 담긴 코드와 대화, 모델의 답변을 저장하지 않습니다. 남는 것은 요청마다의 사용 기록(시각, 모델, 결과, 차감 크레딧)뿐입니다. 답변을 만들기 위해 요청 내용은 선택한 AI 공급자에게 전달되고 공급자 쪽 처리는 각 공급자 정책을 따르니, 자세한 범위는 {safety}에서 확인하세요." },
      { q: "Free 플랜에서도 쓸 수 있나요?", a: "아니요. Tomverse API와 Tomverse CLI는 Pro 이상 플랜에서 쓸 수 있습니다. Free에서는 채팅과 답변 비교를 그대로 쓰고, 코딩 도구에 연결하려면 Pro로 올리면 됩니다." },
      { q: "목록에 없는 도구도 연결되나요?", a: "표준 OpenAI 호환 API(Chat Completions 또는 Responses)나 Anthropic Messages를 쓰는 도구라면 Base URL과 API 키만 바꿔 연결할 수 있습니다. 도구가 쓰는 기능 중 일부는 지원 범위가 다를 수 있습니다." },
      { q: "어떤 모델을 쓸 수 있나요?", a: "계정의 플랜에서 쓸 수 있는 모델 그대로입니다. {models}가 지금 이 키로 쓸 수 있는 모델과 요청당 크레딧을 알려 줍니다." },
      { q: "비용은 어떻게 계산되나요?", a: "채팅과 같은 크레딧에서 요청마다 차감됩니다. 요청을 보낼 때 필요한 크레딧을 먼저 잡아 두고, 답변이 비었거나 실패한 요청은 차감하지 않습니다. 키마다 건 한도를 넘지 않습니다." },
    ],
  },
  cta: {
    title: ["키 하나 만들고,", "쓰던 도구에 붙여 넣으세요."],
    body: "설정 › API 키에서 1분이면 됩니다.",
    primary: "API 키 만들기",
    secondary: "크레딧 알아보기",
  },
};

const en: DevelopersPageCopy = {
  crumb: "Developers",
  hero: {
    title: ["Keep the coding tools you use.", "Pick models from {n} providers."],
    body: "One Tomverse API key connects Codex, Claude Code, Cursor, VS Code and Aside. Cursor, VS Code and Aside can use models from {n} providers, Codex runs on OpenAI models and Claude Code on Anthropic models. Not every request needs the most expensive model. Smart Adaptive picks a suitable model for each request, and a key never goes past the limit you set on it.",
    primary: "Create an API key",
    secondary: "How to connect each tool",
    note: "Available on Pro and above, using the same credits as Chat.",
    motionOff: "Pause animation",
    motionOn: "Resume animation",
  },
  why: {
    eyebrow: "Why connect Tomverse",
    title: ["Sign-ups and payments for every provider,", "folded into one."],
    cards: [
      { k: "Model choice", h: "Same tools, models from {n} providers", p: "Switch between models from {n} providers, including OpenAI, Anthropic, Google, xAI and DeepSeek, with one key. A subscription from a single company cannot do that. Codex chooses among OpenAI models and Claude Code among Anthropic models." },
      { k: "Smart Adaptive", h: "Expensive models only when needed", p: "Light requests go to light models, design and debugging go to advanced ones. Every response tells you which model answered." },
      { k: "Budget", h: "Only what you set aside leaves", p: "Put a credit limit on each key and split keys by project or CI. Credits never go past the limit, and a key can be revoked instantly at any time." },
      { k: "One account", h: "Compare first, then code with that model", p: "Compare answers to see which model suits this coding problem, then put the model you picked straight into your coding tool." },
    ],
  },
  adaptive: {
    eyebrow: "Smart Adaptive",
    title: ["Not every request needs", "the most expensive model."],
    body: [
      "Just put ",
      " as the model name. Naming and small edits go to a light model, architecture and tricky bugs to an advanced one. The model that actually answered is written in the response’s ",
      " field and the ",
      " header. In Codex it chooses among OpenAI models, in Claude Code among Anthropic models.",
    ],
    savingLabels: ["Smart Adaptive", "Advanced model for all"],
    savingNote: "Example credit totals for the five requests on the right.",
    routeAsks: ["Rename these variables to be meaningful", "Add type annotations to this function", "Find why this test fails sometimes", "Polish the README install steps", "Design for splitting the payments module in two"],
    tiers: { light: "Light model", mid: "Mid model", high: "Advanced model" },
    routeNote: "An example. The real choice and credits depend on the request, context length and plan.",
  },
  connect: {
    eyebrow: "Connect your tool",
    title: ["Pick a tool in Settings › API keys", "and the settings to paste appear."],
    note: "A shortened version of the settings that Settings › API keys generates. The real values are filled in with the model you choose and a new key. Cursor’s Tab and Cursor’s own models do not use this key.",
    cursorGuide: "Detailed Cursor guide",
  },
  proto: {
    eyebrow: "Supported protocols",
    title: ["Three standard protocols,", "one key."],
    descriptions: [
      "Cursor, Aside, VS Code and most OpenAI-compatible tools. Supports streaming and function tool calls, and uses models from all {n} providers.",
      "The Codex terminal and IDE extension. Uses OpenAI models.",
      "The Claude Code terminal and VS Code extension. Uses Anthropic models.",
    ],
    flowTool: ["Your coding tool", "The agent and tool runs stay here"],
    flowApi: ["Tomverse API", "Key check · model choice · credit settlement"],
    flowProviders: ["{n} providers", "OpenAI · Anthropic · Google …"],
    privacy: "The Tomverse API is a pass-through: it takes your request, hands it to the model and returns the result. The code in your requests and the model’s answers are not stored. Editing files and running commands happen only inside your own tool, and Tomverse servers never run tools for you.",
  },
  keys: {
    eyebrow: "Keys and limits",
    title: ["Split keys by purpose,", "limit each one."],
    ticks: [
      ["Pro and above", "Free accounts cannot create API keys."],
      ["Up to 10 keys per account", "Separate personal work, team projects and CI with different keys."],
      ["Put a credit limit on each key", "The limit applies to the total credits that key has used. When it is reached only that key stops; your other keys and Chat carry on."],
      ["Instant revocation", "Revoking always works. All a key can do is call models, list models and read its own usage."],
      ["Credits shared with Chat", "Charged together from plan credits and purchased credits."],
    ],
    chipActive: "Active",
    chipRevoked: "Revoked",
    capLabel: "Credit limit for this key",
    capAria: "Credit limit",
    used: "Used {used} / {cap} credits",
    revoke: "Revoke key",
    reset: "Reset example",
    demoNote: "An example screen. You create real keys in Settings › API keys.",
  },
  cli: {
    eyebrow: "Tomverse CLI",
    title: ["No tool needed,", "a terminal is enough."],
    body: "With just a Tomverse API key it is a coding agent that works in your own folder. It reads the code, proposes a diff, runs only the commands you approve, then tells you what it did and what it cost. Install it with an installer (.msi or winget on Windows, .pkg on macOS, .deb or .rpm on Linux), or with npm if you have Node.js.",
    cta: "See the CLI install guide",
  },
  faq: {
    eyebrow: "FAQ",
    title: "Before you connect.",
    safetyLink: "Safety page",
    items: [
      { q: "Is my code stored on Tomverse?", a: "No. Tomverse does not store the code and conversation in your requests or the model’s answers. All that remains is a usage record for each request (time, model, outcome, credits charged). To produce an answer, the request is passed to the AI provider you chose and the provider’s handling follows its own policy, so see the {safety} for the exact scope." },
      { q: "Can I use it on the Free plan?", a: "No. The Tomverse API and Tomverse CLI are available on Pro and above. On Free you keep using Chat and answer comparison; upgrade to Pro to connect a coding tool." },
      { q: "Will tools not on the list connect?", a: "Any tool that uses the standard OpenAI-compatible API (Chat Completions or Responses) or Anthropic Messages can connect by changing only the Base URL and API key. Support for some features the tool uses may differ." },
      { q: "Which models can I use?", a: "Exactly the models your account’s plan can use. {models} tells you which models this key can use right now and the credits per request." },
      { q: "How is it charged?", a: "From the same credits as Chat, per request. The credits a request needs are held when it is sent, and requests that come back empty or fail are not charged. A key never goes past the limit set on it." },
    ],
  },
  cta: {
    title: ["Make one key,", "paste it into your tool."],
    body: "It takes a minute in Settings › API keys.",
    primary: "Create an API key",
    secondary: "Learn about credits",
  },
};

export const developersPageSeo: Record<Language, { title: string; description: string }> = {
  ko: { title: "Tomverse API로 쓰던 코딩 도구 연결", description: "Tomverse API 키 하나로 Codex, Claude Code, Cursor, VS Code, Aside를 연결하고 스마트 자동(Smart Adaptive)으로 요청마다 알맞은 모델을 쓰는 방법. Pro 이상 플랜에서 쓸 수 있습니다." },
  en: { title: "Connect your coding tools with the Tomverse API", description: "Connect Codex, Claude Code, Cursor, VS Code and Aside with one Tomverse API key and let Smart Adaptive pick a suitable model per request. Available on Pro and above." },
  zh: { title: "用 Tomverse API 连接你的编程工具", description: "用一个 Tomverse API 密钥连接 Codex、Claude Code、Cursor、VS Code 和 Aside，并让 Smart Adaptive 为每个请求选择合适的模型。Pro 及以上方案可用。" },
  "zh-Hant": { title: "用 Tomverse API 連接你的程式開發工具", description: "用一組 Tomverse API 金鑰連接 Codex、Claude Code、Cursor、VS Code 和 Aside，並讓 Smart Adaptive 為每個請求選擇合適的模型。Pro 以上方案可用。" },
  fr: { title: "Connectez vos outils de code à l’API Tomverse", description: "Connectez Codex, Claude Code, Cursor, VS Code et Aside avec une seule clé d’API Tomverse, et laissez Smart Adaptive choisir un modèle adapté à chaque requête. Disponible à partir de Pro." },
  de: { title: "Coding-Tools mit der Tomverse-API verbinden", description: "Verbinden Sie Codex, Claude Code, Cursor, VS Code und Aside mit einem Tomverse-API-Schlüssel und lassen Sie Smart Adaptive pro Anfrage ein passendes Modell wählen. Ab Pro verfügbar." },
  es: { title: "Conecta tus herramientas de código con la API de Tomverse", description: "Conecta Codex, Claude Code, Cursor, VS Code y Aside con una sola clave de API de Tomverse y deja que Smart Adaptive elija un modelo adecuado para cada solicitud. Disponible desde Pro." },
  pt: { title: "Conecte suas ferramentas de código à API do Tomverse", description: "Conecte Codex, Claude Code, Cursor, VS Code e Aside com uma única chave de API do Tomverse e deixe o Smart Adaptive escolher um modelo adequado para cada solicitação. Disponível a partir do Pro." },
};

export const developersPageContent: Record<Language, DevelopersPageCopy> = { ko, en, ...developersPageTranslations };
export const developersPageSource = { ko, en };
