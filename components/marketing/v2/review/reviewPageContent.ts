import type { Language } from "@/lib/language";
import { reviewPageTranslations } from "./reviewPageContent.i18n";

/**
 * Copy for the V2 answer comparison page (/products/review; approved concept,
 * owner 2026-11-20). Korean is the approved wording, checked against the code
 * (AI Review modes, lenses, quote matching, the per-item web check, the guest
 * preview and the credit estimates); English and the six other locales follow its
 * meaning. The page's metadata stays in lib/seo.ts (reviewSeoCopy).
 *
 * `{n}` is replaced with the number of providers in the live public model
 * catalogue. `{summary}` and `{review}` are the shelf credits of the two
 * comparison actions (lib/comparisonReviewCost.ts), so the page never states a
 * number that is not data. `{models}` and `{calc}` become links.
 *
 * No customer-facing string uses an em dash or an en dash.
 */
export type ReviewPageCopy = {
  /** Breadcrumb label for this product. */
  crumb: string;
  hero: {
    title: [string, string];
    body: string;
    primary: string;
    /** The primary action once the visitor is signed in. */
    primarySignedIn: string;
    secondary: string;
    note: string;
    motionOff: string;
    motionOn: string;
  };
  demo: {
    sectionLabel: string;
    videoLabel: string;
    caption: string;
  };
  how: {
    eyebrow: string;
    title: [string, string];
    steps: Array<[string, string]>;
  };
  modes: {
    eyebrow: string;
    title: [string, string];
    tabsLabel: string;
    /** [quick difference summary, AI Review]. */
    tabs: [string, string];
    descriptions: [string, string];
    /** One line per answer A, B and C. */
    quickLines: [string, string, string];
    /** Three findings of the example review; the first two quote an answer. */
    findings: Array<{ k: string; p: string; quote?: string; cite?: string }>;
    note: string;
  };
  lens: {
    eyebrow: string;
    title: [string, string];
    body: string;
    tabsLabel: string;
    /** Three review lenses: balance, evidence, action. */
    lenses: Array<{ tab: string; name: string; items: string[] }>;
    note: string;
  };
  trust: {
    eyebrow: string;
    title: [string, string];
    cards: Array<{ k: string; h: string; p: string; f: string }>;
  };
  uses: {
    eyebrow: string;
    title: [string, string];
    cards: Array<{ k: string; h: string; p: string }>;
  };
  after: {
    eyebrow: string;
    title: [string, string];
    ticks: Array<[string, string]>;
    continueWith: string;
    othersPaused: string;
    chip: string;
    say: string;
    note: string;
  };
  providers: {
    eyebrow: string;
    title: [string, string];
    /** `{models}` becomes a link to the models page. */
    note: string;
    modelsLink: string;
  };
  faq: {
    eyebrow: string;
    title: string;
    /** [question, answer]; the credit answer holds `{summary}`, `{review}` and `{calc}`. */
    items: Array<[string, string]>;
    calcLink: string;
  };
  cta: {
    title: [string, string];
    body: string;
    primary: string;
    pricing: string;
  };
};

const ko: ReviewPageCopy = {
  crumb: "답변 비교",
  hero: {
    title: ["한 AI의 답에서 멈추지 마세요.", "세 개를 놓고 고르세요."],
    body: "공급자 {n}곳의 모델 가운데 최대 세 개를 골라 같은 질문을 한 번에 보냅니다. 답이 모이면 AI Review가 같은 점, 다른 점, 빠진 점을 원문 인용과 함께 짚어 줍니다. 어느 답을 믿을지는 직접 정합니다.",
    primary: "세 AI에 물어보기",
    primarySignedIn: "답변 비교 열기",
    secondary: "어떻게 비교하나요",
    note: "가입 없이 세 모델로 바로 비교할 수 있습니다.",
    motionOff: "애니메이션 멈추기",
    motionOn: "애니메이션 다시 재생",
  },
  demo: {
    sectionLabel: "실제 화면",
    videoLabel: "답변 비교 실제 화면 녹화",
    caption: "실제 Tomverse Review 화면을 시연용 데이터로 녹화했습니다. 노트북은 가상의 제품이고, 모델 답변과 분석은 예시입니다. 고객 콘텐츠는 없으며, 공급자 보증이 아닙니다.",
  },
  how: {
    eyebrow: "흐름",
    title: ["탭 세 개를 오가며", "복사하던 일을, 한 번에."],
    steps: [
      ["고르고 묻기", "최대 세 모델을 고르고 질문이나 파일을 한 번만 보냅니다."],
      ["나란히 읽기", "세 답이 동시에 쌓입니다. 길이도, 관점도, 빠뜨린 것도 한눈에 보입니다."],
      ["차이 정리", "AI Review가 합의, 충돌, 누락과 다음에 확인할 것을 항목으로 정리합니다."],
    ],
  },
  modes: {
    eyebrow: "두 가지 정리 방식",
    title: ["훑어볼 땐 빠르게,", "따져야 할 땐 깊게."],
    tabsLabel: "정리 방식",
    tabs: ["빠른 차이 요약", "AI Review"],
    descriptions: [
      "답을 하나하나 다 읽지 않아도 어디서 갈라지는지 몇 줄로 알려 줍니다. 답이 둘 이상 모이면 쓸 수 있고, 크레딧이 적게 듭니다.",
      "항목마다 근거가 된 문장을 인용해 보여 줍니다. 무엇이 같고, 무엇이 충돌하고, 무엇이 빠졌는지 하나씩 확인합니다.",
    ],
    quickLines: [
      "매일 들고 다닐 무게를 먼저 봅니다.",
      "동시에 할 작업과 RAM을 먼저 봅니다.",
      "배터리·화면·CPU가 아직 빠졌다고 봅니다.",
    ],
    findings: [
      { k: "공통점", p: "세 답변 모두 두 제품이 예산 안에 있다고 말합니다.", quote: "“두 제품 모두 예산 안입니다.”", cite: "답변 A · B · C" },
      { k: "관점 차이", p: "A는 무게, B는 RAM을 앞세웁니다. 사실이 충돌하는 게 아니라 고르는 기준이 다릅니다.", quote: "“매일 들고 다닌다면 가벼운 A를 먼저 살펴보세요.”", cite: "답변 A" },
      { k: "추가 확인", p: "C가 짚은 배터리·화면·CPU는 질문에 없던 정보입니다." },
    ],
    note: "예시 화면입니다. 실제 정리는 질문과 답변에 따라 달라집니다.",
  },
  lens: {
    eyebrow: "검토 관점",
    title: ["무엇을 중점으로 볼지", "먼저 정하세요."],
    body: "같은 세 답이라도 무엇을 확인하고 싶은지에 따라 정리가 달라집니다. 관점을 바꾸면 AI Review가 앞세우는 항목이 바뀝니다.",
    tabsLabel: "검토 관점",
    lenses: [
      { tab: "균형", name: "균형 · 합의, 차이, 누락, 유용성을 고르게", items: ["세 답이 함께 말하는 것: 두 제품 모두 예산 안", "기준이 갈리는 곳: 무게(A)와 RAM(B)", "모두 빠뜨린 것: 실제 작업 목록", "가장 쓸모 있는 다음 질문: 매일 여는 프로그램이 무엇인지"] },
      { tab: "근거", name: "근거 · 근거 없는 주장, 충돌, 근거 공백 위주", items: ["근거 없이 단정한 문장: 없음", "서로 충돌하는 사실: 없음, 기준 차이만 있음", "근거 공백: 배터리 사용 시간과 화면 정보가 질문에 없음", "확인할 출처: 제조사 사양표"] },
      { tab: "실행", name: "실행 · 실질적인 다음 단계, 장단점, 위험 위주", items: ["바로 할 일: 매일 쓰는 프로그램 목록 적기", "장단점: A는 가볍지만 여유 RAM이 적고, B는 그 반대", "위험: 8GB로 부족하면 1년 안에 교체 고민", "결정 기준: 무게 1.5kg 이하가 꼭 필요한지"] },
    ],
    note: "예시 화면입니다.",
  },
  trust: {
    eyebrow: "확인할 수 있게",
    title: ["정리한 내용도", "다시 확인할 수 있게."],
    cards: [
      { k: "인용문 일치율", h: "인용이 원문과 맞는지", p: "AI Review가 인용한 문장을 원래 답변과 다시 대조해, 정확히 일치한 비율을 함께 보여 줍니다.", f: "사실이 맞을 확률이 아니라 인용의 정확도입니다" },
      { k: "두 번째 검토", h: "검토 모델을 하나 더", p: "두 번째 검토 모델을 쓸 수 있으면 두 결과를 나란히 읽을 수 있습니다. 인용문 일치 등급이 같은지, 정확히 일치한 인용문이 몇 개나 겹치는지 보여 줍니다.", f: "어느 답이 정답인지 합의했다는 뜻은 아닙니다" },
      { k: "항목별 웹 확인", h: "확인이 필요한 항목만 따로", p: "검토에서 확인이 필요하다고 표시한 항목 하나를 따로 웹으로 확인해, 최신 출처가 뒷받침하는지, 반박하는지, 판단할 수 없는지 봅니다.", f: "로그인 필요 · 크레딧 별도" },
      { k: "선을 지킵니다", h: "정답을 대신 고르지 않습니다", p: "AI Review는 받은 답변끼리만 비교합니다. 중요한 판단은 최신 1차 출처나 전문가로 확인하세요.", f: "판단은 직접" },
    ],
  },
  uses: {
    eyebrow: "이럴 때 쓰세요",
    title: ["두 번째 의견이", "값진 순간들."],
    cards: [
      { k: "결정", h: "무엇을 고를지 망설일 때", p: "노트북, 공부 계획, 여행 일정처럼 선택지가 있는 질문을 세 관점으로 비교합니다." },
      { k: "문서", h: "긴 자료를 읽을 때", p: "같은 PDF를 세 모델에 함께 물어, 서로 놓친 내용을 찾습니다. 발췌를 모델마다 붙여 넣을 필요가 없습니다." },
      { k: "코드 · 계획", h: "틀리면 비싼 일일 때", p: "최소 수정안, 장단점, 실패 경로와 빠진 테스트를 모델별로 견줘 봅니다." },
    ],
  },
  after: {
    eyebrow: "비교한 다음",
    title: ["마음에 든 답과", "이어서 대화하세요."],
    ticks: [
      ["한 모델에게만 이어 묻기", "다 본 패널은 멈추고, 고른 모델과 계속 이야기합니다. 원래 비교는 그대로 남습니다."],
      ["파일과 함께 다시 묻기", "이미지, PDF, Office 문서, Google Drive 파일을 붙여 이어 갑니다. 비회원은 지원하는 파일을 임시로 붙일 수 있고, Google Drive 연결은 계정이 필요합니다."],
      ["기록으로 남기기", "프로젝트로 정리하고, 읽기 전용 링크로 공유하거나 텍스트로 내보냅니다. 계정이 필요하고, 공유 링크는 만료될 수 있습니다."],
    ],
    continueWith: "Claude Fable 5.2와 계속",
    othersPaused: "다른 두 패널은 멈춤",
    chip: "이어서",
    say: "“B안 기준으로, 내 예산에서 RAM을 16GB로 올릴 때 무엇을 포기하게 되는지 정리해 줘.”",
    note: "예시 화면입니다.",
  },
  providers: {
    eyebrow: "공급자 {n}곳",
    title: ["공급자마다 탭을 열지 않고,", "한 화면에서 고르세요."],
    note: "고를 수 있는 모델은 플랜에 따라 다릅니다. {models}",
    modelsLink: "전체 모델 보기",
  },
  faq: {
    eyebrow: "자주 묻는 질문",
    title: "시작하기 전에.",
    items: [
      ["무료로 비교해 볼 수 있나요?", "네. 로그인하지 않아도 세 모델로 같은 질문을 바로 비교할 수 있습니다. 비회원은 하루·한 달 사용량이 정해져 있고 첫 메시지 전에 간단한 확인 단계가 있으며, 무료 계정을 만들면 더 많은 모델과 높은 한도, 대화 저장을 쓸 수 있습니다."],
      ["비교 한 번에 크레딧은 얼마나 드나요?", "고른 모델마다 크레딧이 들고, 모델과 요청 길이에 따라 달라지며 긴 대화나 파일은 더 많이 듭니다. 정리 단계는 따로 드는데, 빠른 차이 요약은 약 {summary} 크레딧, AI Review는 약 {review} 크레딧으로 안내합니다. 실제 값은 실행할 때 서버가 계산합니다. 모델 조합으로 한 달에 몇 번 비교할 수 있는지는 {calc}에서 계산해 볼 수 있습니다."],
      ["AI Review가 틀릴 수도 있나요?", "그렇습니다. AI Review는 받은 답변끼리만 비교하고, 스스로 사실을 확정하거나 정답을 고르지 않습니다. 인용문 일치율과 항목별 웹 확인으로 근거를 직접 확인하세요."],
    ],
    calcLink: "크레딧 계산기",
  },
  cta: {
    title: ["다음 중요한 질문은", "세 AI에게 같이 물어보세요."],
    body: "가입 없이, 지금 바로.",
    primary: "세 AI에 물어보기",
    pricing: "요금제 보기",
  },
};

const en: ReviewPageCopy = {
  crumb: "Review",
  hero: {
    title: ["Don’t stop at one AI’s answer.", "Weigh three side by side."],
    body: "Pick up to three models from {n} providers and send them the same question at once. When the answers are in, AI Review points out what they share, where they differ and what is missing, with quotes from the originals. Which answer to trust is still your call.",
    primary: "Ask three AIs",
    primarySignedIn: "Open answer comparison",
    secondary: "How does it compare?",
    note: "Compare with three models right away, no sign-up needed.",
    motionOff: "Pause animation",
    motionOn: "Play animation again",
  },
  demo: {
    sectionLabel: "The real screen",
    videoLabel: "Recording of the real answer comparison screen",
    caption: "A recording of the real Tomverse Review screen with demonstration data. The laptop is a made-up product, and the model answers and analysis are examples. No customer content. Not a provider endorsement.",
  },
  how: {
    eyebrow: "How it works",
    title: ["Copying between three tabs", "becomes one step."],
    steps: [
      ["Choose and ask", "Pick up to three models and send one question or file, once."],
      ["Read side by side", "All three answers build up at the same time. Length, angle and what each one left out are clear at a glance."],
      ["Sort out the differences", "AI Review lays out agreements, conflicts, omissions and what to check next, item by item."],
    ],
  },
  modes: {
    eyebrow: "Two ways to sum up",
    title: ["Quick when you’re skimming,", "deep when it has to hold up."],
    tabsLabel: "How to sum up",
    tabs: ["Quick difference summary", "AI Review"],
    descriptions: [
      "Tells you in a few lines where the answers split, without reading each one in full. Available once two or more answers are in, and it costs few credits.",
      "Shows the sentence behind every item as a quote. You check what is the same, what conflicts and what is missing, one by one.",
    ],
    quickLines: [
      "Looks first at the weight you’ll carry every day.",
      "Looks first at the work you’ll run together and the RAM.",
      "Says battery, screen and CPU are still missing.",
    ],
    findings: [
      { k: "Common ground", p: "All three answers say both products fit the budget.", quote: "“Both products are within budget.”", cite: "Answers A · B · C" },
      { k: "Different angles", p: "A leads with weight, B with RAM. The facts don’t conflict; they pick different criteria.", quote: "“If you carry it every day, look at the lighter A first.”", cite: "Answer A" },
      { k: "Worth checking", p: "The battery, screen and CPU that C raises were not in your question." },
    ],
    note: "This is an example screen. Real summaries depend on your question and the answers.",
  },
  lens: {
    eyebrow: "Review lens",
    title: ["Decide what to weigh", "first."],
    body: "The same three answers sum up differently depending on what you want to check. Change the lens and AI Review puts different items first.",
    tabsLabel: "Review lens",
    lenses: [
      { tab: "Balanced", name: "Balanced · agreement, differences, omissions and usefulness evenly", items: ["What all three say: both products fit the budget", "Where the criteria split: weight (A) and RAM (B)", "What all of them left out: your actual workload", "Most useful next question: which programs you open every day"] },
      { tab: "Evidence", name: "Evidence · unsupported claims, conflicts and evidence gaps", items: ["Sentences stated without support: none", "Facts that conflict: none, only different criteria", "Evidence gaps: battery life and screen details are not in the question", "Source to check: the manufacturer’s spec sheet"] },
      { tab: "Action", name: "Action · practical next steps, trade-offs and risks", items: ["Do now: list the programs you use every day", "Trade-offs: A is light but has little spare RAM, B is the opposite", "Risk: if 8GB falls short, you may think about replacing it within a year", "Deciding factor: whether you really need 1.5kg or lighter"] },
    ],
    note: "This is an example screen.",
  },
  trust: {
    eyebrow: "So you can check it",
    title: ["Even the summary", "can be checked again."],
    cards: [
      { k: "Quote match rate", h: "Do the quotes match the originals?", p: "AI Review matches each quote it uses back against the original answer and shows the share that matched exactly.", f: "It measures how accurately it quotes, not the probability that a claim is true" },
      { k: "Second review", h: "One more review model", p: "When a second AI review model is available, you can read both results side by side. It shows whether their quote-match grades are the same and how many exact quotes they share. This does not mean they agree about which answer is correct.", f: "It does not mean they agree about which answer is correct" },
      { k: "Per-item web check", h: "Only the items that need checking", p: "Run a separate web check on a single item the review flagged, to see whether current sources support it, contradict it or are inconclusive.", f: "Sign-in required · charged separately" },
      { k: "It keeps its line", h: "It doesn’t pick the right answer for you", p: "AI Review compares only the answers it is given. For important decisions, check current primary sources or an expert.", f: "The judgement stays yours" },
    ],
  },
  uses: {
    eyebrow: "When to use it",
    title: ["Moments when a second opinion", "is worth it."],
    cards: [
      { k: "Decisions", h: "When you can’t decide what to pick", p: "Compare questions with options, like a laptop, a study plan or a trip itinerary, from three angles." },
      { k: "Documents", h: "When you’re reading something long", p: "Ask three models about the same PDF and find what each one missed. No pasting excerpts into each model." },
      { k: "Code · plans", h: "When a mistake is expensive", p: "Compare the smallest fix, the trade-offs, the failure paths and the missing tests, model by model." },
    ],
  },
  after: {
    eyebrow: "After comparing",
    title: ["Keep talking with", "the answer you liked."],
    ticks: [
      ["Follow up with one model", "Pause the panels you are done with and keep talking with the model you picked. The original comparison stays."],
      ["Ask again with files", "Continue with images, PDFs, Office documents and Google Drive files. Guests can attach supported files temporarily; connecting Google Drive needs an account."],
      ["Keep it as a record", "Organise it into a project, share a read-only link or export it as text. An account is required, and share links can expire."],
    ],
    continueWith: "Continue with Claude Fable 5.2",
    othersPaused: "The other two panels pause",
    chip: "Continue",
    say: "“Based on plan B, sum up what I give up if I raise RAM to 16GB within my budget.”",
    note: "This is an example screen.",
  },
  providers: {
    eyebrow: "{n} providers",
    title: ["No tab for each provider.", "Choose on one screen."],
    note: "Which models you can choose depends on your plan. {models}",
    modelsLink: "See all models",
  },
  faq: {
    eyebrow: "FAQ",
    title: "Before you start.",
    items: [
      ["Can I compare for free?", "Yes. You can compare the same question across three models without signing in. Guest use has its own daily and monthly allowance and a quick verification step before the first message, and a free account unlocks more models, higher limits and saved conversations."],
      ["How many credits does one comparison cost?", "Each model you pick uses credits, depending on the model and the length of the request, and long conversations or files cost more. Summing up is charged separately, in credits: roughly {summary} for a quick difference summary and {review} for AI Review. The server works out the real figure when it runs. You can work out how many comparisons a month a combination of models allows in the {calc}."],
      ["Can AI Review be wrong?", "Yes. AI Review compares only the answers it is given, and it neither settles facts nor picks a correct answer. Use the quote match rate and the per-item web check to verify the evidence yourself."],
    ],
    calcLink: "credit calculator",
  },
  cta: {
    title: ["Ask the next important question", "to three AIs together."],
    body: "No sign-up, right now.",
    primary: "Ask three AIs",
    pricing: "See pricing",
  },
};

export const reviewPageContent: Record<Language, ReviewPageCopy> = {
  ko,
  en,
  ...reviewPageTranslations,
};
