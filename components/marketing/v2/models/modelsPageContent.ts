import type { Language } from "@/lib/language";
import { modelsPageTranslations } from "./modelsPageContent.i18n";

/**
 * Copy for the V2 models page (/models; approved concept, owner 2026-11-20).
 * Korean is the approved wording; English and the six other locales follow its
 * meaning.
 *
 * The page states no model, provider, credit figure or capability of its own: the
 * list, every credit number and every tag come from the live public model
 * catalogue. Placeholders the component fills from that catalogue:
 * `{n}` the number of providers, `{shown}` and `{total}` the filtered and the
 * full model counts, `{count}` and `{names}` the models in a credit range,
 * `{tokens}`, `{a}`, `{b}` and `{x}` the input-size thresholds and multipliers.
 */
export type ModelsPageCopy = {
  crumb: string;
  hero: {
    title: [string, string];
    body: string;
    primary: string;
    secondary: string;
  };
  list: {
    sectionLabel: string;
    searchLabel: string;
    searchPlaceholder: string;
    filtersToggle: string;
    rows: { plan: string; grade: string; feature: string; provider: string };
    all: string;
    /** Chip labels for the plan a model's access starts with. */
    plans: { Guest: string; Free: string; Pro: string };
    planNote: string;
    features: { image: string; reasoning: string; oneCredit: string };
    tags: { image: string; reasoning: string; limited: string };
    count: string;
    clear: string;
    empty: string;
    /** Credit unit for exactly one credit, then for any other number. */
    creditUnit: [string, string];
    creditLabel: string;
    note: string;
    guideLink: string;
  };
  credits: {
    eyebrow: string;
    title: [string, string];
    body: string;
    /** Three price ranges, lowest first: [heading, line with `{count}` and `{names}`]. */
    bands: [[string, string], [string, string], [string, string]];
    calc: string;
    guide: {
      summary: string;
      intro: string;
      files: string;
      bandUpTo: string;
      bandBetween: string;
      bandOver: string;
      bandValue: string;
      outro: string;
    };
  };
  cta: {
    title: [string, string];
    body: string;
    review: string;
    status: string;
  };
};

const ko: ModelsPageCopy = {
  crumb: "모델",
  hero: {
    title: ["공급자 {n}곳의 모델,", "한 목록에서."],
    body: "이용 플랜, 크레딧, 이미지 입력과 추론 여부로 걸러 보세요. 채팅과 답변 비교에서 고를 수 있는 모델입니다. 고르기 어렵다면 스마트 자동(Smart Adaptive)에 맡기면 됩니다.",
    primary: "모델 찾아보기",
    secondary: "스마트 자동 알아보기",
  },
  list: {
    sectionLabel: "모델 목록",
    searchLabel: "모델 검색",
    searchPlaceholder: "모델이나 공급자 이름",
    filtersToggle: "필터",
    rows: { plan: "이용 시작 플랜", grade: "크레딧 등급", feature: "기능", provider: "공급자" },
    all: "전체",
    plans: { Guest: "로그인 없이", Free: "무료 계정", Pro: "Pro 이상" },
    planNote: "로그인 없이: 게스트 사용 한도가 적용됩니다. 무료 계정: Tomverse 무료 계정이 필요합니다. Pro 이상: 유료 플랜이 필요합니다.",
    features: { image: "이미지 입력", reasoning: "추론 기능", oneCredit: "1 크레딧" },
    tags: { image: "이미지", reasoning: "추론", limited: "제공 제한" },
    count: "표시된 모델: {shown} / {total}",
    clear: "필터 초기화",
    empty: "조건에 맞는 모델이 없습니다. 필터를 하나 풀어 보세요.",
    creditUnit: ["크레딧", "크레딧"],
    creditLabel: "짧은 요청의 기본 크레딧",
    note: "크레딧은 짧은 요청 한 번의 기본값입니다. 대화와 파일이 길어지면 입력 크기에 따라 배율이 붙습니다.",
    guideLink: "입력 크기와 크레딧 배율 보기",
  },
  credits: {
    eyebrow: "크레딧 읽는 법",
    title: ["숫자는 짧은 요청 한 번의", "기본 크레딧입니다."],
    body: "어떤 모델을 쓰든 같은 계정의 AI 크레딧에서 차감되고, 드는 양은 모델마다 다릅니다. 숫자가 클수록 같은 짧은 요청의 기본 비용이 높다는 뜻이며, 성능 순위는 아닙니다. 답변 비교에서는 고른 모델들의 값을 더한 만큼 듭니다.",
    bands: [
      ["기본 비용이 낮은 모델", "이 구간의 모델 {count}개 · 예: {names}"],
      ["기본 비용이 중간인 모델", "이 구간의 모델 {count}개 · 예: {names}"],
      ["기본 비용이 높은 모델", "이 구간의 모델 {count}개 · 예: {names}"],
    ],
    calc: "크레딧 계산기로 한 달 사용량 보기",
    guide: {
      summary: "입력 크기와 크레딧 배율",
      intro: "짧은 요청의 기본 크레딧은 1배로 적용됩니다. 배율은 서버가 추정한 요청 입력 크기로 정해지며, 대화 기록과 파일 내용, 그 밖에 요청에 포함된 맥락을 모두 더합니다. 글자 수나 마지막 메시지 하나만 보는 것이 아닙니다.",
      files: "모델에 직접 보내는 이미지와 PDF는 텍스트를 추출하지 않아도 크레딧 배율 계산에서 파일 하나당 {tokens} 토큰으로 셉니다. 이런 파일 하나에 텍스트 1토큰이 더해지면 {x}배 구간에 들어갑니다. 다른 파일은 추출된 텍스트가 더해질 수 있습니다. 이 기준은 입력 한도에 쓰는 이미지 토큰 추정과 다를 수 있습니다.",
      bandUpTo: "{a} 토큰 이하",
      bandBetween: "{a} 토큰 초과 {b} 토큰 이하",
      bandOver: "{a} 토큰 초과",
      bandValue: "기본 크레딧의 {x}배",
      outro: "기본 크레딧에 입력 배율을 곱한 값은 모델마다 올려서 정수 크레딧으로 계산합니다. 검색과 Deep Research 같은 도구는 비용이 더 들거나 따로 계산될 수 있습니다. 입력창의 숫자는 기본 추정이며 실제 사용량은 요청 처리와 정산에서 달라질 수 있습니다. 모델의 컨텍스트 최대치가 앱의 입력 한도를 넘겨 주지는 않습니다.",
    },
  },
  cta: {
    title: ["고르기 어렵다면,", "세 모델에게 같이 물어보세요."],
    body: "답변 비교로 질문에 맞는 모델을 직접 확인할 수 있습니다.",
    review: "답변 비교 알아보기",
    status: "실시간 서비스 상태",
  },
};

const en: ModelsPageCopy = {
  crumb: "Models",
  hero: {
    title: ["Models from {n} providers,", "in one list."],
    body: "Filter by plan, credits, image input and reasoning. These are the models you can pick in Chat and answer comparison. If choosing is hard, leave it to Smart Adaptive.",
    primary: "Browse models",
    secondary: "About Smart Adaptive",
  },
  list: {
    sectionLabel: "Model list",
    searchLabel: "Search models",
    searchPlaceholder: "Model or provider name",
    filtersToggle: "Filters",
    rows: { plan: "Access starts with", grade: "Credit category", feature: "Features", provider: "Provider" },
    all: "All",
    plans: { Guest: "No sign-in", Free: "Free account", Pro: "Pro or above" },
    planNote: "No sign-in: guest usage limits apply. Free account: requires a free Tomverse account. Pro or above: requires a paid plan.",
    features: { image: "Image input", reasoning: "Reasoning support", oneCredit: "1 credit" },
    tags: { image: "Images", reasoning: "Reasoning", limited: "Limited availability" },
    count: "Models shown: {shown} / {total}",
    clear: "Clear filters",
    empty: "No models match these filters. Try removing one.",
    creditUnit: ["credit", "credits"],
    creditLabel: "Base credits for a short request",
    note: "Credits are the base for one short request. Longer conversations and files add a multiplier by input size.",
    guideLink: "Input size and credit multipliers",
  },
  credits: {
    eyebrow: "Reading credits",
    title: ["The number is the base credits", "for one short request."],
    body: "Whichever model you use, it draws on the same account’s AI credits, and the amount differs by model. A larger number means a higher base cost for the same short request; it is not a performance ranking. In answer comparison, the cost is the total of the models you choose.",
    bands: [
      ["Lower base cost", "Models in this range: {count}. Example: {names}"],
      ["Medium base cost", "Models in this range: {count}. Example: {names}"],
      ["Higher base cost", "Models in this range: {count}. Example: {names}"],
    ],
    calc: "See a month of usage in the credit calculator",
    guide: {
      summary: "Input size and credit multipliers",
      intro: "The short-request base credits apply at 1×. The multiplier uses the server’s estimated request input, including conversation history, file content and other included request context. It is not a character count or just your latest message.",
      files: "Images and PDFs sent directly to a model count with a fixed {tokens}-token allowance per file for credit weighting, even when no text is extracted. One such file plus one text token enters the {x}× band. Other file inputs can contribute extracted text. This credit allowance can differ from the image-token estimate used for input limits.",
      bandUpTo: "Up to {a} tokens",
      bandBetween: "More than {a}, up to {b} tokens",
      bandOver: "More than {a} tokens",
      bandValue: "{x}× base credits",
      outro: "Base credits × the input multiplier are rounded up to whole credits per model. Search, Deep Research and other tools may have additional or separate charges. The composer shows a base estimate; request processing and settlement can change final usage. A model’s context maximum does not override app input limits.",
    },
  },
  cta: {
    title: ["Can’t decide?", "Ask three models together."],
    body: "Answer comparison lets you see for yourself which model fits your question.",
    review: "About answer comparison",
    status: "Live service status",
  },
};

export const modelsPageContent: Record<Language, ModelsPageCopy> = {
  ko,
  en,
  ...modelsPageTranslations,
};
