import type { Language } from "@/lib/language";
import { cursorGuideTranslations } from "./cursorGuideContent.i18n";

/**
 * Copy for the Cursor connection guide (/developers/cursor; Figma draft approved
 * by the owner 2026-11-21). Korean is the approved wording; English and the six
 * other locales follow its meaning. Facts follow docs/policy/external-api.md and
 * the production Cursor runs recorded in its section 10.5.
 *
 * Placeholders: `{shown}` and `{total}` (rows shown / listed), `{count}` (models
 * only Smart Adaptive reaches), `{credits}` (a receipt's credits), `{id}` (a
 * model id in a copy button's name). Product, tool and setting names, ids and
 * URLs stay untranslated.
 */
export type CursorGuideCopy = {
  crumbDevelopers: string;
  hero: {
    title: string;
    body: string;
    primary: string;
    secondary: string;
    chips: [string, string, string];
  };
  toc: {
    label: string;
    items: [string, string, string, string, string, string, string, string];
    cardBody: string;
    cardAction: string;
  };
  notice: { title: string; body: string };
  steps: {
    title: string;
    items: [{ title: string; body: string }, { title: string; body: string }, { title: string; body: string }];
    keySwitch: string;
    urlSwitch: string;
    urlNote: string;
    builtIn: string;
    recommended: string;
    copyTitle: string;
    copy: string;
    copied: string;
  };
  routing: {
    title: string;
    lead: string;
    head: [string, string, string];
    toTomverse: string;
    toCursor: string;
    rows: [{ pick: string; result: string }, { pick: string; result: string }, { pick: string; result: string }, { pick: string; result: string }];
  };
  models: {
    title: string;
    lead: string;
    search: string;
    all: string;
    source: string;
    head: [string, string, string, string];
    smartName: string;
    smartProvider: string;
    smartCredits: string;
    copyId: string;
    copiedId: string;
    shown: string;
    showAll: string;
    showLess: string;
    empty: string;
    smartOnly: string;
    creditsNote: string;
    renamedTitle: string;
    renamedBody: string;
  };
  verify: {
    title: string;
    lead: string;
    receiptTitle: string;
    receiptKey: string;
    credits: string;
    done: string;
    stopped: string;
    hint: string;
  };
  faq: { title: string; items: Array<{ q: string; a: string }> };
  back: string;
};

const ko: CursorGuideCopy = {
  crumbDevelopers: "개발자",
  hero: {
    title: "Cursor에서 Tomverse 모델 쓰기",
    body: "Cursor의 OpenAI 설정 세 칸을 채우면 Chat과 Agent가 Tomverse API로 동작합니다. 모델은 직접 고르거나 스마트 자동(Smart Adaptive)에 맡기세요. 요청마다 어느 모델이 답했는지 영수증에 남습니다.",
    primary: "API 키 만들기",
    secondary: "모델 ID 표 보기",
    chips: ["Pro 이상", "채팅과 같은 크레딧", "Chat · Agent · 중단 확인됨"],
  },
  toc: {
    label: "이 페이지",
    items: ["먼저 알아 두기", "1. API 키 만들기", "2. Cursor에 키와 주소 넣기", "3. 모델 추가하기", "어떤 모델이 Tomverse로 가나요", "모델 이름과 ID", "연결 확인하기", "문제 해결"],
    cardBody: "설정 › API 키에서 Cursor를 고르면 내 키와 주소가 채워진 설정을 그대로 복사할 수 있습니다.",
    cardAction: "API 키 화면 열기",
  },
  notice: {
    title: "먼저 알아 두세요",
    body: "Cursor는 OpenAI 주소 하나만 바꿀 수 있습니다. 그래서 Tomverse로 오는 요청은 Tomverse 모델 ID를 추가해 고른 요청과, Cursor 목록에서 고른 OpenAI 모델뿐입니다. Cursor 목록의 Claude·Gemini·Grok, Auto, Composer, Tab 자동완성은 Cursor 요금으로 처리됩니다.",
  },
  steps: {
    title: "연결하기",
    items: [
      { title: "API 키 만들기", body: "Tomverse 설정 › API 키에서 새 키를 만들고 도구로 Cursor를 고릅니다. 키는 만들 때 한 번만 전체가 보이니 바로 복사해 두세요." },
      { title: "Cursor에 키와 주소 넣기", body: "Cursor Settings › Models › API Keys에서 아래 두 칸을 채우고 두 스위치를 켭니다." },
      { title: "모델 추가하기", body: "같은 화면의 + Add Custom Model에 smart-adaptive를 추가하고 켭니다. 특정 모델을 쓰려면 아래 표의 ID를 추가합니다. 그다음 모델 선택 목록에서 추가한 이름을 고릅니다." },
    ],
    keySwitch: "Use API Key",
    urlSwitch: "켜기",
    urlNote: "Cursor는 자기 서버에서 이 주소로 요청을 보냅니다. 그래서 localhost 주소는 쓸 수 없습니다.",
    builtIn: "Claude · Cursor 기본 목록",
    recommended: "추천",
    copyTitle: "한 번에 보기 — 설정 › API 키에서 내 키로 채워진 값을 복사할 수 있습니다",
    copy: "복사",
    copied: "복사됨",
  },
  routing: {
    title: "어떤 모델이 Tomverse로 가나요",
    lead: "Cursor 모델 목록에서 무엇을 고르느냐에 따라 요청이 가는 곳이 다릅니다.",
    head: ["고른 모델", "가는 곳", "결과"],
    toTomverse: "Tomverse로",
    toCursor: "Cursor로",
    rows: [
      { pick: "추가한 Tomverse 모델 ID (smart-adaptive, gpt-6-luna …)", result: "Tomverse 크레딧으로 답합니다. 영수증에 답한 모델이 남습니다." },
      { pick: "Cursor 목록의 OpenAI 모델", result: "Tomverse에 같은 모델이 있으면 그 모델로 답하고, 없으면 model_not_found 오류가 납니다." },
      { pick: "Cursor 목록의 Claude · Gemini · Grok", result: "Cursor 요금으로 처리되고 Tomverse 키를 쓰지 않습니다. Tomverse로 쓰려면 아래 표의 ID를 추가하세요." },
      { pick: "Auto · Composer · Tab 자동완성", result: "Cursor 자체 기능이라 Tomverse를 거치지 않습니다." },
    ],
  },
  models: {
    title: "모델 이름과 ID",
    lead: "Cursor에 추가할 때는 ID를 그대로 붙여 넣습니다. 이 표는 Tomverse 모델 카탈로그에서 바로 읽어 오므로, 모델이 새로 생기거나 이름이 바뀌면 표도 함께 바뀝니다.",
    search: "모델 이름이나 ID로 찾기",
    all: "전체",
    source: "Tomverse 모델 카탈로그 기준",
    head: ["모델", "Cursor에 넣을 ID", "공급사", "요청당 크레딧"],
    smartName: "스마트 자동 (Smart Adaptive)",
    smartProvider: "여러 공급사",
    smartCredits: "답한 모델",
    copyId: "{id} 복사",
    copiedId: "{id} 복사됨",
    shown: "{total}개 중 {shown}개를 보여 줍니다",
    showAll: "모두 보기",
    showLess: "접기",
    empty: "찾는 모델이 없습니다. 이름이나 ID를 다시 확인해 주세요.",
    smartOnly: "가장 비싼 모델 {count}개는 ID로 직접 부를 수 없고, smart-adaptive가 가장 어려운 요청에만 씁니다.",
    creditsNote: "요청당 크레딧은 보통 길이의 요청 하나가 쓰는 기본값입니다. 긴 요청은 더 쓰고, 실제로 쓴 크레딧은 요청마다 영수증에 남습니다.",
    renamedTitle: "더는 쓰지 않는 ID",
    renamedBody: "예전 ID를 Cursor에 추가해 두었다면 오른쪽에 있는 대신 쓸 ID로 바꿔 주세요. 이 목록도 카탈로그에서 읽어 옵니다.",
  },
  verify: {
    title: "연결 확인하기",
    lead: "Cursor Chat에서 짧은 질문을 하나 보내 보세요. 답이 오고 Tomverse 영수증에 요청이 생기면 연결된 것입니다.",
    receiptTitle: "설정 › API 키 › 영수증",
    receiptKey: "Cursor 키",
    credits: "{credits} 크레딧",
    done: "완료",
    stopped: "중단됨",
    hint: "smart-adaptive로 보낸 요청은 실제로 답한 모델이 화살표 오른쪽에 적힙니다. 중간에 멈춘 답은 받은 만큼만 크레딧이 빠집니다.",
  },
  faq: {
    title: "문제 해결",
    items: [
      { q: "“… is not included in your weekly usage”가 떠요", a: "Cursor 목록의 모델을 골라서 Cursor가 막은 것입니다. 이 요청은 Tomverse로 오지 않습니다. 추가한 Tomverse ID(예: gemini-4-neon)를 고르세요." },
      { q: "“Override OpenAI Base URL returned HTTP 401”", a: "키가 틀렸거나 만료·폐기되었습니다. 설정 › API 키에서 키 상태를 보고, 필요하면 새 키를 만들어 다시 넣으세요." },
      { q: "model_not_found 오류가 나요", a: "ID 철자가 다르거나 지금 이 계정에서 쓸 수 없는 모델입니다. 위 표에서 ID를 복사해 다시 추가하세요." },
      { q: "HTTP 400이 나요", a: "오류 문구에 막힌 기능이나 값이 적혀 있습니다. 그 기능은 Tomverse에서 쓸 수 없는 것입니다. 문구와 Request ID를 지원팀에 보내 주시면 서버 기록과 맞춰 봅니다." },
      { q: "Tomverse를 잠시 끄고 싶어요", a: "Cursor Settings에서 OpenAI API Key와 Override OpenAI Base URL 스위치를 끄면 Cursor가 원래대로 돌아갑니다. 추가한 모델은 그대로 둬도 됩니다." },
      { q: "답이 중간에 멈췄어요", a: "Stop을 누르거나 연결이 끊기면, 받은 만큼만 크레딧이 정산되고 영수증에 ‘중단됨’으로 남습니다." },
    ],
  },
  back: "개발자 페이지로 돌아가기",
};

const en: CursorGuideCopy = {
  crumbDevelopers: "Developers",
  hero: {
    title: "Use Tomverse models in Cursor",
    body: "Fill in three of Cursor’s OpenAI settings and Chat and Agent run on the Tomverse API. Pick a model yourself or leave it to Smart Adaptive. Every receipt shows which model answered.",
    primary: "Create an API key",
    secondary: "See the model IDs",
    chips: ["Pro and above", "Same credits as Chat", "Chat · Agent · Stop verified"],
  },
  toc: {
    label: "On this page",
    items: ["Before you start", "1. Create an API key", "2. Add the key and URL to Cursor", "3. Add a model", "Which models go to Tomverse", "Model names and IDs", "Check the connection", "Troubleshooting"],
    cardBody: "Pick Cursor in Settings › API keys to copy these settings with your key and the URL already filled in.",
    cardAction: "Open API keys",
  },
  notice: {
    title: "Before you start",
    body: "Cursor can change only its OpenAI address. So the requests that reach Tomverse are the ones where you pick a Tomverse model ID you added, and the OpenAI models in Cursor’s list. Claude, Gemini and Grok from Cursor’s list, Auto, Composer and Tab completion are billed by Cursor.",
  },
  steps: {
    title: "Connect",
    items: [
      { title: "Create an API key", body: "In Tomverse Settings › API keys, create a new key and pick Cursor as the tool. The full key is shown only once, so copy it right away." },
      { title: "Add the key and URL to Cursor", body: "In Cursor Settings › Models › API Keys, fill in the two fields below and turn on both switches." },
      { title: "Add a model", body: "On the same screen, add smart-adaptive with + Add Custom Model and turn it on. To use a specific model, add its ID from the table below. Then pick the name you added in the model menu." },
    ],
    keySwitch: "Use API Key",
    urlSwitch: "On",
    urlNote: "Cursor sends these requests from its own servers, so a localhost address cannot work.",
    builtIn: "Claude · Cursor’s own list",
    recommended: "Recommended",
    copyTitle: "All at once — Settings › API keys gives you these values with your key filled in",
    copy: "Copy",
    copied: "Copied",
  },
  routing: {
    title: "Which models go to Tomverse",
    lead: "Where a request goes depends on what you pick in Cursor’s model menu.",
    head: ["What you pick", "Goes to", "What happens"],
    toTomverse: "Tomverse",
    toCursor: "Cursor",
    rows: [
      { pick: "A Tomverse model ID you added (smart-adaptive, gpt-6-luna …)", result: "Answered with Tomverse credits. The receipt shows the model that answered." },
      { pick: "An OpenAI model in Cursor’s list", result: "If Tomverse offers the same model it answers; if not, you get a model_not_found error." },
      { pick: "Claude · Gemini · Grok in Cursor’s list", result: "Billed by Cursor, without your Tomverse key. To use them through Tomverse, add their IDs from the table below." },
      { pick: "Auto · Composer · Tab completion", result: "Cursor’s own features, which never go through Tomverse." },
    ],
  },
  models: {
    title: "Model names and IDs",
    lead: "When you add a model to Cursor, paste its ID as it is. This table is read straight from the Tomverse model catalogue, so it changes when a model is added or renamed.",
    search: "Search by model name or ID",
    all: "All",
    source: "From the Tomverse model catalogue",
    head: ["Model", "ID to add in Cursor", "Provider", "Credits per request"],
    smartName: "Smart Adaptive",
    smartProvider: "Several providers",
    smartCredits: "The model that answers",
    copyId: "Copy {id}",
    copiedId: "Copied {id}",
    shown: "Showing {shown} of {total}",
    showAll: "Show all",
    showLess: "Show fewer",
    empty: "No model matches. Check the name or ID.",
    smartOnly: "The {count} most expensive models cannot be named directly; smart-adaptive uses them for the hardest requests only.",
    creditsNote: "Credits per request is the base for one request of ordinary length. Longer requests use more, and every receipt shows what a request actually used.",
    renamedTitle: "Retired IDs",
    renamedBody: "If you added one of these IDs to Cursor, change it to the ID on its right. This list is read from the catalogue too.",
  },
  verify: {
    title: "Check the connection",
    lead: "Send a short question in Cursor Chat. If an answer comes back and the request appears in your Tomverse receipts, you are connected.",
    receiptTitle: "Settings › API keys › Receipts",
    receiptKey: "Cursor key",
    credits: "{credits} credits",
    done: "Completed",
    stopped: "Stopped",
    hint: "For a request sent to smart-adaptive, the model that actually answered appears after the arrow. A reply you stop is charged only for what you received.",
  },
  faq: {
    title: "Troubleshooting",
    items: [
      { q: "“… is not included in your weekly usage”", a: "You picked a model from Cursor’s list and Cursor stopped it. The request never reached Tomverse. Pick a Tomverse ID you added (for example gemini-4-neon)." },
      { q: "“Override OpenAI Base URL returned HTTP 401”", a: "The key is wrong, expired or revoked. Check it in Settings › API keys and, if needed, create a new key and paste it again." },
      { q: "I get model_not_found", a: "The ID is misspelt, or this account cannot use that model now. Copy the ID from the table above and add it again." },
      { q: "I get HTTP 400", a: "The error names the feature or value it refused; that feature is not available through Tomverse. Send the message and the Request ID to support and we will match it against the server record." },
      { q: "I want to turn Tomverse off for a while", a: "In Cursor Settings, turn off the OpenAI API Key and Override OpenAI Base URL switches and Cursor goes back to normal. You can leave the models you added." },
      { q: "A reply stopped halfway", a: "If you press Stop or the connection drops, only what you received is charged, and the receipt says Stopped." },
    ],
  },
  back: "Back to Developers",
};

export const cursorGuideSeo: Record<Language, { title: string; description: string }> = {
  ko: { title: "Cursor에서 Tomverse 모델 쓰기", description: "Cursor의 OpenAI 키, Base URL, 사용자 모델 세 칸으로 Tomverse API를 연결하는 방법과 Cursor에 넣을 모델 ID 표. Pro 이상 플랜에서 쓸 수 있습니다." },
  en: { title: "Use Tomverse models in Cursor", description: "Connect Cursor to the Tomverse API with three settings (OpenAI key, base URL, custom model) and find the model ID to add for each model. Available on Pro and above." },
  zh: { title: "在 Cursor 中使用 Tomverse 模型", description: "用 Cursor 的 OpenAI 密钥、Base URL 和自定义模型三项设置连接 Tomverse API，并查到每个模型要添加的模型 ID。Pro 及以上方案可用。" },
  "zh-Hant": { title: "在 Cursor 中使用 Tomverse 模型", description: "用 Cursor 的 OpenAI 金鑰、Base URL 和自訂模型三項設定連接 Tomverse API，並查到每個模型要加入的模型 ID。Pro 以上方案可用。" },
  fr: { title: "Utiliser les modèles Tomverse dans Cursor", description: "Connectez Cursor à l’API Tomverse avec trois réglages (clé OpenAI, URL de base, modèle personnalisé) et trouvez l’ID à ajouter pour chaque modèle. Disponible à partir de Pro." },
  de: { title: "Tomverse-Modelle in Cursor nutzen", description: "Verbinden Sie Cursor mit drei Einstellungen (OpenAI-Schlüssel, Basis-URL, eigenes Modell) mit der Tomverse-API und finden Sie die Modell-ID für jedes Modell. Ab Pro verfügbar." },
  es: { title: "Usar los modelos de Tomverse en Cursor", description: "Conecta Cursor a la API de Tomverse con tres ajustes (clave de OpenAI, URL base y modelo personalizado) y encuentra el ID que debes añadir para cada modelo. Disponible desde Pro." },
  pt: { title: "Usar os modelos do Tomverse no Cursor", description: "Conecte o Cursor à API do Tomverse com três configurações (chave da OpenAI, URL base e modelo personalizado) e encontre o ID a adicionar para cada modelo. Disponível a partir do Pro." },
};

export const cursorGuideContent: Record<Language, CursorGuideCopy> = { ko, en, ...cursorGuideTranslations };
export const cursorGuideSource = { ko, en };
