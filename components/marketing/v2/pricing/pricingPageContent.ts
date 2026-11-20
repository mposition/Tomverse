import type { Language } from "@/lib/language";
import { pricingPageTranslations } from "./pricingPageContent.i18n";

/**
 * Copy for the V2 pricing page (/pricing; approved concept, owner 2026-11-20).
 * Korean is the approved wording; English and the six other locales follow its meaning.
 *
 * The page states no price, credit figure, pack or model count of its own. All of them come
 * from the billing config (/api/billing/config), the model catalogue and the credit constants,
 * and are filled into these placeholders:
 *
 * - `{standard}`, `{daily}`, `{n}` (credits): a counted credit amount, unit included
 * - `{premium}`: the Free plan's monthly higher-cost model responses
 * - `{percent}`: the featured promotion's discount, `{tokens}`: the configured input ceiling
 * - `{amount}`: a formatted price, `{plan}`: a plan name, `{n}` / `{total}`: model counts
 * - `{k}`, `{mult}`, `{models}`, `{web}`: the calculator's thresholds and amounts
 * - `{calc}` and `{models}` in a sentence become links; `{days}` is a pack's validity
 *
 * Wording that the previous pricing page already carried in all eight languages (plan lines,
 * promotion labels, credit packs, table rows, FAQ) is kept as it was reviewed.
 */
type PlanRow = { label: string; free: string; pro: string; max: string };

export type PricingPageCopy = {
  crumb: string;
  hero: {
    title: [string, string];
    body: string;
    primary: string;
    secondary: string;
    motionOff: string;
    motionOn: string;
  };
  points: { items: Array<[string, string]>; note: string };
  plans: {
    /** Screen-reader heading above the three plan cards. */
    heading: string;
    recommended: string;
    /** Who each plan is for, in the order Free, Pro, Max. */
    who: [string, string, string];
    /** Four short lines per plan. */
    ticks: { free: string[]; pro: string[]; max: string[] };
    lockedNote: string;
    /** "per month" as it follows a price. */
    period: string;
    periodYear: string;
    creditUnit: { one: string; other: string };
    creditsLabel: string;
    dailyLabel: string;
    dailyNone: string;
    viewModels: string;
    modelCount: string;
    /** Button label for Free, Pro, Max. */
    cta: [string, string, string];
    annual: string;
    save: string;
    checkout: string;
    equivalent: string;
    billingChoice: string;
    billingChoiceSignedOut: string;
    note: string;
    starterPrefix: string;
    sale: { badge: string; regular: string; duration: string };
    promo: { code: string; ends: string; eligibility: string; timezone: string; discount: string; billingNote: string };
  };
  models: {
    title: string;
    sub: string;
    close: string;
    locked: string;
    /** One note per plan, in the order Free, Pro, Max. */
    notes: [string, string, string];
    catalogLink: string;
  };
  calc: {
    eyebrow: string;
    title: [string, string];
    pick: string;
    /** Standard, Advanced, Premium: [name, one-line description]. */
    tiers: [[string, string], [string, string], [string, string]];
    ctxLabel: string;
    ctxShort: string;
    ctxOver: string;
    ctxAria: string;
    ctxHint: string;
    searchLabel: string;
    searchSmall: string;
    perLabel: string;
    breakdown: string;
    breakdownWeb: string;
    requests: string;
    note: string;
    higher: string;
    modelsLink: string;
    /** Shown while long context is off and an input ceiling is configured; `{tokens}` is the ceiling. */
    inputLimitNote: string;
    /** Shown only while long context is configured; `{tokens}` is the configured ceiling. */
    longContextNote: string;
  };
  packs: {
    eyebrow: string;
    title: string;
    description: string;
    availableFor: string;
    oneTime: string;
    validity: string;
    credits: string;
    policyTitle: string;
    policies: string[];
    guidance: string;
    purchaseCta: string;
    loading: string;
    packNames: Record<"starter_500" | "project_1500" | "power_4000", string>;
    packDescriptions: Record<"starter_500" | "project_1500" | "power_4000", string>;
  };
  compare: {
    eyebrow: string;
    title: string;
    scrollLabel: string;
    /** Feature, Free, Pro, Max. */
    headers: [string, string, string, string];
    models: PlanRow;
    comparison: PlanRow;
    files: PlanRow;
    sharing: PlanRow;
    creditsLabel: string;
    daily: string;
    deep: string;
    tools: string;
    toolsValue: string;
    list: string;
    attachmentsOff: string;
  };
  faq: {
    eyebrow: string;
    title: string;
    items: Array<{ question: string; answer: string; promotionOnly?: boolean }>;
    /** `{calc}` in an answer becomes a link with this text. */
    calcLink: string;
  };
  cta: { title: string; primary: string; secondary: string; note: string };
};

const ko: PricingPageCopy = {
  crumb: "요금제",
  hero: {
    title: ["무료로 써 보고,", "쓰는 만큼 올리세요."],
    body: "모델별 할당량은 따로 없습니다. 매달 받는 AI 크레딧 하나로 어떤 모델이든 쓰고, 5시간이나 일주일 단위로 끊기는 사용 제한도 없습니다. 가벼운 모델은 요청당 {standard}부터, 고급 모델일수록 더 많이 듭니다.",
    primary: "무료로 시작하기",
    secondary: "내 사용량 계산해 보기",
    motionOff: "애니메이션 멈추기",
    motionOn: "애니메이션 다시 재생",
  },
  points: {
    items: [
      ["모델별 횟수 제한 없음", "GPT든 Claude든 Gemini든, 크레딧이 남아 있으면 모델마다 따로 정해진 횟수 없이 씁니다. Free의 고비용 모델 한도는 아래 안내를 확인하세요."],
      ["5시간 · 주간 초기화 없음", "몇 시간마다, 일주일마다 기다릴 필요가 없습니다. 기준은 월 크레딧이고, 하루 사용 한도는 각 플랜에 표시됩니다."],
      ["크레딧 하나로 모든 기능", "채팅, 답변 비교, 코딩 도구 연결이 같은 크레딧에서 차감됩니다."],
    ],
    note: "Free는 하루 {daily} 한도가 있고, 고비용 모델은 월 {premium}회까지 쓸 수 있습니다. 비정상 사용과 비용 폭증을 막는 운영 안전장치는 모든 플랜에 적용됩니다.",
  },
  plans: {
    heading: "플랜",
    recommended: "추천",
    who: ["처음 시작하는 사용자", "일상 생산성", "고강도 AI 워크플로"],
    ticks: {
      free: ["선별된 모델 이용", "선별된 고비용 모델 월 최대 {premium}응답", "최대 3개 모델 비교", "로그인 후 파일 첨부, 공유 및 다운로드"],
      pro: ["모든 사용 가능 모델 이용", "모델별 크레딧 차감량에 따라 월 제공량 사용", "최대 3개 모델 나란히 비교", "파일 첨부 및 Google Drive 파일"],
      max: ["모든 사용 가능 모델 이용", "Premium 등급 모델 사용에는 월 크레딧 및 공정 사용 정책 적용", "첨부 허용 시 10개 · 각 50 MiB · 총 100 MiB", "고급 모델과 긴 문서를 자주 쓰는 경우에 적합"],
    },
    lockedNote: "Pro 이상 전용 모델은 쓸 수 없습니다.",
    period: "월",
    periodYear: "년",
    creditUnit: { one: "크레딧", other: "크레딧" },
    creditsLabel: "월 AI 크레딧",
    dailyLabel: "하루 사용 한도",
    dailyNone: "없음",
    viewModels: "이 플랜의 모델 보기",
    modelCount: "{n}개 / {total}개",
    cta: ["무료로 시작", "Pro로 업그레이드", "Max로 업그레이드"],
    annual: "연간",
    save: "20% 할인",
    checkout: "최종 결제 통화와 금액은 결제 화면에서 확인하세요.",
    equivalent: "월 환산 약 {amount}, 연간 일괄 결제",
    billingChoice: "다음 단계에서 월간 또는 연간 결제를 선택합니다. 결제 전에 확인하세요.",
    billingChoiceSignedOut: "로그인한 뒤 다음 단계에서 월간 또는 연간 결제를 선택합니다. 결제 전에 확인하세요.",
    note: "가격은 함께 표시된 통화의 세금 전 고정 금액입니다. 플랜별 일일 크레딧 한도와 모델별 운영 안전장치는 현재 사용량 안내를 확인하세요.",
    starterPrefix: "다음 기능에서 오셨습니다: ",
    sale: { badge: "출시 특가", regular: "정가", duration: "첫 달 적용" },
    promo: {
      code: "코드",
      ends: "종료",
      eligibility: "월간 Pro 또는 Max · 계정당 1회",
      timezone: "브리즈번 시간",
      discount: "{percent}% 할인",
      billingNote: "출시 특가: Pro 또는 Max 첫 달 {percent}% 할인. 언제든 취소할 수 있습니다.",
    },
  },
  models: {
    title: "{plan}에서 쓸 수 있는 모델 {n}개",
    sub: "전체 {total}개 중 {n}개 · 숫자는 짧은 요청 한 번의 기본 크레딧",
    close: "닫기",
    locked: "Pro 이상 전용 모델 {n}개",
    notes: ["고비용 모델은 Free에서 월 {premium}회까지 쓸 수 있습니다. 하루 사용 한도는 {daily}입니다.", "모든 모델이 같은 월 크레딧에서 차감됩니다.", "Premium 등급 모델은 월 크레딧과 공정 사용 정책 안에서 씁니다."],
    catalogLink: "모델별 기본 크레딧 모두 보기",
  },
  calc: {
    eyebrow: "크레딧 계산기",
    title: ["한 달에 몇 번 물어볼 수 있을까요?", "직접 골라 보세요."],
    pick: "한 번에 함께 물어볼 모델 (최대 3개)",
    tiers: [["Standard 모델", "빠르고 가벼운 질문"], ["Advanced 모델", "정리, 분석, 글쓰기"], ["Premium 모델", "깊은 추론과 긴 작업"]],
    ctxLabel: "대화·첨부파일 길이",
    ctxShort: "짧음",
    ctxOver: "{k}K 초과",
    ctxAria: "입력 문맥 길이",
    ctxHint: "첨부한 파일의 내용도 입력 길이에 들어갑니다. 긴 PDF나 여러 파일을 붙일수록 오른쪽입니다.",
    searchLabel: "웹 검색 사용",
    searchSmall: "모델 하나당 +{n} · 검색이 실제로 실행되지 않으면 돌려받습니다",
    perLabel: "한 번 보낼 때",
    breakdown: "모델 {models} · 길이 {mult}×",
    breakdownWeb: " · 웹 검색 {web}",
    requests: "{n}회",
    note: "예시이며 보장 횟수가 아닙니다. 웹 검색 크레딧은 입력 길이와 관계없이 모델마다 고정이고, Perplexity 모델은 검색 비용이 기본값에 들어 있어 더해지지 않습니다.",
    higher: "더 높은 등급의 모델은 위 예시보다 크레딧이 더 듭니다. 모델별 기본 크레딧은 {models}에서 확인하세요.",
    modelsLink: "모델 페이지",
    inputLimitNote: "한 번에 처리하는 입력은 {tokens}토큰까지이며 모든 플랜에 같습니다.",
    longContextNote: "로그인 계정의 입력이 {tokens}토큰을 넘으면 실제 공급사 비용으로 차감하며, 위 배율로 계산한 차감량보다 적게 차감하지는 않습니다. 보내기 전에 최대 사용량을 잡아 두고, 쓰지 않은 만큼은 돌려드립니다.",
  },
  packs: {
    eyebrow: "일회성 추가 상품",
    title: "플랜 변경 없이 크레딧만 더 필요하신가요?",
    description: "이번 달 작업량이 많거나 일시적인 프로젝트가 있을 때 추가 크레딧 팩을 구매할 수 있습니다. 통화 코드와 고정 가격을 확인하고 로그인 후 결제할 수 있습니다.",
    availableFor: "구매 가능 플랜",
    oneTime: "일회성 구매",
    validity: "{days}일 유효",
    credits: "크레딧",
    policyTitle: "추가 크레딧 이용 방식",
    policies: [
      "월 플랜 크레딧을 먼저 사용한 뒤 만료일이 빠른 추가 크레딧부터 차감합니다.",
      "추가 크레딧은 모델·기능을 해제하지 않으며 일일 한도, 공정사용 및 플랜별 제한도 늘리지 않습니다.",
      "플랜을 변경하거나 해지해도 미사용 추가 크레딧은 표시된 만료일까지 유지됩니다.",
    ],
    guidance: "Free는 반복 사용 시 Pro 업그레이드가 우선이며 Starter 팩은 일시적인 추가 사용용입니다. Pro·Max는 한 번의 프로젝트에는 팩을, 매월 사용량이 반복해서 많다면 상위 플랜을 권장합니다.",
    purchaseCta: "로그인하고 크레딧 구매",
    loading: "현재 크레딧 팩 가격을 불러오는 중…",
    packNames: { starter_500: "Starter 크레딧 팩", project_1500: "Project 크레딧 팩", power_4000: "Power 크레딧 팩" },
    packDescriptions: {
      starter_500: "이번 달 사용량이 조금 더 필요한 Free 사용자를 위한 소형 팩입니다.",
      project_1500: "문서, 리서치 또는 단기 프로젝트를 위한 추가 사용량입니다.",
      power_4000: "플랜 변경 없이 집중적인 Pro·Max 작업을 이어가기 위한 대용량 팩입니다.",
    },
  },
  compare: {
    eyebrow: "한눈에 비교",
    title: "플랜별 제공 기능 비교",
    scrollLabel: "플랜 비교표, 가로로 스크롤됩니다",
    headers: ["기능", "Free", "Pro", "Max"],
    models: { label: "모델 접근", free: "선별된 모델", pro: "모든 사용 가능 모델 · Pro 사용량 적용", max: "모든 사용 가능 모델 · 가장 큰 월 제공량" },
    comparison: { label: "다중 모델 비교", free: "최대 3개 모델", pro: "최대 3개 모델", max: "최대 3개 모델" },
    files: { label: "파일 첨부 (허용 시)", free: "10개 · 각 50 MiB · 총 100 MiB", pro: "10개 · 각 50 MiB · 총 100 MiB", max: "10개 · 각 50 MiB · 총 100 MiB" },
    sharing: { label: "대화 공유", free: "공유 및 다운로드", pro: "공유 및 다운로드", max: "공유 및 다운로드" },
    creditsLabel: "AI 크레딧",
    daily: "하루 사용 한도",
    deep: "Deep Research",
    tools: "코딩 도구 연결 (Tomverse API · CLI)",
    toolsValue: "✓ 계정 크레딧 · 키마다 한도",
    list: "목록",
    attachmentsOff: "현재 제공하지 않음",
  },
  faq: {
    eyebrow: "자주 묻는 질문",
    title: "결정하기 전에.",
    items: [
      {
        question: "무료로 계속 사용할 수 있나요?",
        answer: "네. Free에서는 플랜 사용 한도 안에서 일상 질문에 선별된 모델을 이용할 수 있습니다. 로그인하면 대화를 저장하고 지원되는 파일 첨부, 공유와 다운로드 기능도 사용할 수 있습니다.",
      },
      {
        question: "출시 할인은 어떻게 적용되나요?",
        answer: "출시 특가로 Pro 또는 Max 첫 달 동안 {percent}% 할인을 받을 수 있습니다. 이후에는 취소하지 않는 한 정가 월 요금으로 갱신됩니다.",
        promotionOnly: true,
      },
      {
        question: "Pro에서 선택할 수 있는 모델이 제한되나요?",
        answer: "Pro에서 사용할 수 있는 모델은 모델 목록과 선택창에서 확인할 수 있습니다. 선택한 모델과 요청 길이에 따라 크레딧이 차감되며, 플랜 사용량과 기능별 이용 조건이 적용됩니다.",
      },
      { question: "크레딧은 어떻게 차감되나요?", answer: "모델마다 짧은 요청의 기본 크레딧이 정해져 있고, 대화와 파일이 길어지면 배율이 붙습니다. 위의 {calc}로 미리 계산해 볼 수 있습니다." },
      { question: "코딩 도구에서 쓰면 따로 결제하나요?", answer: "아닙니다. Tomverse API와 CLI는 Pro 이상 플랜에서 같은 계정의 크레딧을 씁니다. 키마다 한도를 걸어 두면 그 이상은 쓰이지 않습니다." },
    ],
    calcLink: "크레딧 계산기",
  },
  cta: { title: "먼저 써 보고 정하세요.", primary: "무료로 시작하기", secondary: "모델별 크레딧 보기", note: "가입 없이 바로 시작할 수 있습니다." },
};

const en: PricingPageCopy = {
  crumb: "Pricing",
  hero: {
    title: ["Try it free,", "move up as you use more."],
    body: "There are no per-model quotas. One monthly pool of AI credits covers any model, and there are no 5-hour or weekly cut-offs. Light models start at {standard} per request; more advanced models cost more.",
    primary: "Start free",
    secondary: "Calculate my usage",
    motionOff: "Pause animation",
    motionOn: "Resume animation",
  },
  points: {
    items: [
      [
        "No per-model caps",
        "GPT, Claude or Gemini: while you have credits left, there is no separate count for each model. Free’s limit on higher-cost models is explained below.",
      ],
      [
        "No 5-hour or weekly resets",
        "Nothing to wait out every few hours or every week. The measure is your monthly credits, and each plan shows its daily limit.",
      ],
      ["One credit pool for everything", "Chat, answer comparison and coding-tool connections all draw from the same credits."],
    ],
    note: "Free has a daily limit of {daily} and up to {premium} higher-cost model responses a month. Operational safeguards against abnormal use and runaway cost apply to every plan.",
  },
  plans: {
    heading: "Plans",
    recommended: "Recommended",
    who: ["For starting out", "For everyday productivity", "For heavier AI workflows"],
    ticks: {
      free: [
        "Access to selected models",
        "Up to {premium} selected higher-cost model responses per month",
        "Compare up to 3 models",
        "File attachments, sharing and downloads after sign-in",
      ],
      pro: [
        "Access to all available models",
        "Monthly credits cover each model’s credit cost",
        "Compare up to 3 models side by side",
        "File attachments and Google Drive files",
      ],
      max: [
        "Access to all available models",
        "Premium usage follows monthly credits and the Fair Use Policy",
        "Where attachments are enabled: 10 files per message · 50 MiB each · 100 MiB combined",
        "For frequent advanced-model and long-document work",
      ],
    },
    lockedNote: "Models for Pro and above are not available.",
    period: "per month",
    periodYear: "per year",
    creditUnit: { one: "credit", other: "credits" },
    creditsLabel: "Monthly AI credits",
    dailyLabel: "Daily limit",
    dailyNone: "None",
    viewModels: "See this plan’s models",
    modelCount: "{n} of {total}",
    cta: ["Start free", "Upgrade to Pro", "Upgrade to Max"],
    annual: "Annual · billed annually",
    save: "Save 20%",
    checkout: "The fixed local price shown is charged once per year at checkout.",
    equivalent: "Monthly equivalent: about {amount}, billed annually.",
    billingChoice: "Choose monthly or annual billing in the next step, before payment.",
    billingChoiceSignedOut: "Choose monthly or annual billing in the next step after signing in, before payment.",
    note: "Prices are shown before tax in the selected fixed billing currency. On Max, Standard models have no daily limit; Premium usage is subject to monthly credits and the Fair Use Policy.",
    starterPrefix: "You came from ",
    sale: { badge: "Launch special", regular: "Regular", duration: "for the first month" },
    promo: {
      code: "Code",
      ends: "Ends",
      eligibility: "Monthly Pro or Max · one use per account",
      timezone: "Brisbane time",
      discount: "{percent}% off",
      billingNote: "Launch special: {percent}% off Pro or Max for your first month. Cancel anytime.",
    },
  },
  models: {
    title: "{plan}: {n} models you can use",
    sub: "{n} of {total} models · the number is the base credits for one short request",
    close: "Close",
    locked: "{n} models for Pro and above",
    notes: [
      "Higher-cost models are available on Free up to {premium} responses a month. The daily limit is {daily}.",
      "Every model draws from the same monthly credits.",
      "Premium-category models follow your monthly credits and the Fair Use Policy.",
    ],
    catalogLink: "See base credits for every model",
  },
  calc: {
    eyebrow: "Credit calculator",
    title: ["How many times a month can you ask?", "Pick it yourself."],
    pick: "Models to ask together (up to 3)",
    tiers: [
      ["Standard models", "Fast, light questions"],
      ["Advanced models", "Summaries, analysis, writing"],
      ["Premium models", "Deep reasoning and long tasks"],
    ],
    ctxLabel: "Conversation and attachment length",
    ctxShort: "Short",
    ctxOver: "Over {k}K",
    ctxAria: "Input context length",
    ctxHint: "The content of attached files counts toward input length. The more long PDFs or files you attach, the further right it goes.",
    searchLabel: "Use web search",
    searchSmall: "+{n} per model · returned if no search actually runs",
    perLabel: "Per send",
    breakdown: "Models {models} · length {mult}×",
    breakdownWeb: " · web search {web}",
    requests: "{n} requests",
    note: "An example, not a guaranteed count. The web search credit is fixed per model whatever the input length, and Perplexity models already include search cost in their base credits, so nothing is added.",
    higher: "Higher categories use more credits than this example; see {models} for each model’s base credits.",
    modelsLink: "the models page",
    inputLimitNote: "Input is processed up to {tokens} tokens per request, the same on every plan.",
    longContextNote: "Above {tokens} input tokens (signed-in accounts), a request is charged its actual provider cost, never less than the multiplier charge above: the most it can use is held before sending, and the unused part is returned.",
  },
  packs: {
    eyebrow: "One-time add-ons",
    title: "Need more credits without changing plans?",
    description: "Buy an additional credit pack for a temporary project or a busier month. Fixed local pricing is shown and checkout is available after sign-in.",
    availableFor: "Available on",
    oneTime: "One-time purchase",
    validity: "Valid for {days} days",
    credits: "credits",
    policyTitle: "How additional credits work",
    policies: [
      "Monthly plan credits are used first, followed by additional credits with the earliest expiry.",
      "Additional credits do not unlock models or features and do not raise daily, fair-use, or plan-specific limits.",
      "Unused additional credits remain available after a plan change or cancellation until their displayed expiry date.",
    ],
    guidance: "Free: Pro remains the recommended upgrade for recurring use; the Starter pack is for occasional overflow. Pro and Max: use packs for one-off work and upgrade when higher usage repeats each month.",
    purchaseCta: "Sign in to buy credits",
    loading: "Loading current credit-pack pricing…",
    packNames: { starter_500: "Starter Credit Pack", project_1500: "Project Credit Pack", power_4000: "Power Credit Pack" },
    packDescriptions: {
      starter_500: "A small add-on for Free users who need a little more usage this month.",
      project_1500: "Extra capacity for a document, research, or short-term project.",
      power_4000: "A larger add-on for intensive Pro or Max work without changing plans.",
    },
  },
  compare: {
    eyebrow: "At a glance",
    title: "Compare what each plan unlocks",
    scrollLabel: "Plan comparison table, scrolls horizontally",
    headers: ["Feature", "Free", "Pro", "Max"],
    models: {
      label: "Model access",
      free: "Selected models",
      pro: "All available models · Pro usage limits",
      max: "All available models · largest monthly allowance",
    },
    comparison: { label: "Multi-model comparison", free: "Up to 3 models", pro: "Up to 3 models", max: "Up to 3 models" },
    files: {
      label: "File attachments (where enabled)",
      free: "10 files · 50 MiB each · 100 MiB total",
      pro: "10 files · 50 MiB each · 100 MiB total",
      max: "10 files · 50 MiB each · 100 MiB total",
    },
    sharing: { label: "Conversation sharing", free: "Share and download", pro: "Share and download", max: "Share and download" },
    creditsLabel: "AI credits",
    daily: "Daily limit",
    deep: "Deep Research",
    tools: "Coding tools (Tomverse API · CLI)",
    toolsValue: "✓ Account credits · per-key cap",
    list: "List",
    attachmentsOff: "Not offered right now",
  },
  faq: {
    eyebrow: "Frequently asked",
    title: "Before you decide.",
    items: [
      {
        question: "Can I keep using Tomverse for free?",
        answer: "Yes. Free gives you access to selected models for everyday questions within the plan’s usage limits. Sign in to save conversations and use supported file, sharing and download features.",
      },
      {
        question: "How does the launch discount work?",
        answer: "The launch special gives {percent}% off Pro or Max for the first month. After that, the plan renews at the regular monthly price unless canceled.",
        promotionOnly: true,
      },
      {
        question: "Does Pro restrict which models I can choose?",
        answer: "See the catalogue and model selector for models available on Pro. Credits depend on the selected model and request length, within the plan’s usage and feature limits.",
      },
      {
        question: "How are credits deducted?",
        answer: "Each model has base credits for a short request, and a multiplier applies as conversations and files get longer. You can work it out in advance with the {calc} above.",
      },
      {
        question: "Do I pay separately for coding tools?",
        answer: "No. The Tomverse API and CLI use the same account credits on Pro and above. Set a cap per key and nothing beyond it is used.",
      },
    ],
    calcLink: "credit calculator",
  },
  cta: {
    title: "Try it first, then decide.",
    primary: "Start free",
    secondary: "See credits per model",
    note: "You can start right away, without signing up.",
  },
};

export const pricingPageContent: Record<Language, PricingPageCopy> = {
  ko,
  en,
  ...pricingPageTranslations,
};
