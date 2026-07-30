import type { Language } from "@/components/LanguageProvider";
import type { BillingPlanId } from "@/lib/billingPlanDefaults";

// Every string the landing page renders, in every supported language.
//
// It lives here rather than inside the section components for two reasons.
// The first is size: the page now covers eight sections and seven locales.
// The second is the defect this file was created to close -- the previous
// copy table was `{ en } & Partial<Record<Language, LandingCopy>>`, so a key
// that no component read (and a locale that never overrode one) was
// indistinguishable from a key that shipped. `Record<Language, LandingCopy>`
// with no spread means a missing translation is a type error, and the audit
// in .github/audits/insight-homepage-content-audit-2026-07-30.md lists the
// keys that had been translated seven times over while rendering nowhere.
//
// Rule for adding to it: a claim goes in only if the shipped product does
// the thing. Conditions that a visitor would otherwise discover after
// signing up belong in the `condition` field beside the claim, not in a
// footnote three sections away.

/** A feature claim plus, when one applies, the access or cost condition on it. */
export type LandingCard = {
  title: string;
  description: string;
  condition?: string;
};

export type LandingCopy = {
  badge: string;
  brandNote: string;
  title: string;
  description: string;
  primaryCta: string;
  signedInCta: string;
  heroSignupNote: string;
  guestNote: string;
  preview: {
    title: string;
    count: string;
    answers: string[];
    reviewTitle: string;
    reviewItems: string[];
    /** The mock-up is decorative, so this is what a screen reader gets instead. */
    srDescription: string;
  };
  compare: {
    eyebrow: string;
    title: string;
    description: string;
    stepsLabel: string;
    steps: string[];
    quickSummary: LandingCard;
    aiReviewBridge: string;
  };
  evidence: {
    eyebrow: string;
    title: string;
    description: string;
    webSearch: LandingCard;
    deepResearch: LandingCard;
    sourceGrounding: LandingCard;
    itemVerification: LandingCard;
    footnote: string;
    cta: string;
  };
  proof: {
    eyebrow: string;
    title: string;
    description: string;
    workflowLabel: string;
    workflowTitle: string;
    workflowBody: string;
    workflowDisclosure: string;
    stages: Array<{ title: string; caption: string }>;
    steps: Array<{ title: string; description: string }>;
    terminologyNote: string;
    reviewModesLabel: string;
    reviewModes: string[];
    dualReviewerLabel: string;
    dualReviewer: string;
    casesTitle: string;
    casesDescription: string;
    cases: Array<{ title: string; description: string; result: string; link: string }>;
    reviewBoundary: string;
  };
  support: {
    title: string;
    description: string;
    items: LandingCard[];
    accountNote: string;
    cta: string;
  };
  catalogue: {
    title: string;
    description: string;
    providerNote: string;
    planNote: string;
    statusNote: string;
    modelFinderLead: string;
    modelFinderCta: string;
    cta: string;
    statusCta: string;
  };
  trust: {
    title: string;
    description: string;
    items: LandingCard[];
    metricPeriod: string;
    comparisonMetric: string;
    fileMetric: string;
    metricDisclosure: string;
    safetyCta: string;
  };
  pricing: {
    title: string;
    description: string;
    plans: Array<{ id: BillingPlanId; title: string; blurb: string }>;
    creditsLine: string;
    creditsUnknown: string;
    monthly: string;
    dailyLimitNote: string;
    noDailyLimitNote: string;
    deepResearchNote: string;
    detailsCta: string;
  };
  faqTitle: string;
  faqs: Array<{ question: string; answer: string }>;
  ctaTitle: string;
  ctaDescription: string;
};

const en: LandingCopy = {
  badge: "Tomverse Insight · Multi-AI Comparison & Review",
  brandNote: "Tomverse Insight is the multi-AI comparison and review experience from Tomverse.",
  title: "Ask once.\nCompare multiple AI answers.",
  description:
    "Compare GPT, Claude, and Gemini side by side,\nthen use AI Review to find differences and missing points.",
  primaryCta: "Start chatting free",
  signedInCta: "Continue chatting",
  heroSignupNote: "No sign-up required—start with three models.",
  guestNote: "No sign-up required—compare GPT, Claude, and Gemini side by side.",
  preview: {
    title: "One question, multiple perspectives",
    count: "3 models",
    answers: ["Clear next steps", "Risks and trade-offs", "Concise operating plan"],
    reviewTitle: "Tomverse AI Review",
    reviewItems: ["Common ground", "Contradiction", "Missing point", "Verify next"],
    srDescription:
      "Illustration: one question answered by three models side by side, with an AI Review panel grouping common ground, contradictions, missing points, and what to verify next.",
  },
  compare: {
    eyebrow: "The core loop",
    title: "One question goes to several models at once.",
    description:
      "Choose the models, send the question once, and read the answers next to each other. Two ways to make sense of them: a quick difference summary, or a full AI Review.",
    stepsLabel: "The loop",
    steps: ["Choose up to three models", "Ask once or attach a file", "Compare, review, follow up, or share"],
    quickSummary: {
      title: "Quick difference summary",
      description:
        "Once two or more answers are in, have AI summarise where they diverge—without reading all of them line by line. Built for a fast read, not a full review.",
      condition: "Low credit cost. Usage allowances differ between guest and signed-in use.",
    },
    aiReviewBridge:
      "When the differences matter enough to work through, AI Review takes the same answers further—section by section, with quotes.",
  },
  evidence: {
    eyebrow: "Evidence and currency",
    title: "Answers you can check, not just compare.",
    description:
      "Comparing several answers narrows the question. These are the tools for the part that comes after: where a claim came from, and whether it still holds.",
    webSearch: {
      title: "Web search",
      description:
        "Turn web search on for a conversation so supported models answer using current sources and return citations. Choose off, a suggestion when a question looks time-sensitive, or search on every turn.",
      condition: "Support varies by model. Extra credits apply only when a search actually runs.",
    },
    deepResearch: {
      title: "Deep Research",
      description:
        "Send one question to an extended research run across many web sources. It runs as its own long job rather than a normal chat reply, and asks you to confirm before it starts.",
      condition: "Pro plan and above. Uses credits.",
    },
    sourceGrounding: {
      title: "Source grounding",
      description:
        "AI Review quotes the answers it is comparing. Each quote is matched back against the answer it came from, and the share that matched exactly is shown with the review.",
      condition: "It measures quote matching—not factual accuracy, and not a probability that a claim is true.",
    },
    itemVerification: {
      title: "Per-item web check",
      description:
        "For an item the review flagged as needing verification, run a separate web check on just that item and see whether current sources support it, contradict it, or are inconclusive.",
      condition: "A separate opt-in step from the review itself. Signed-in, uses a search model, and is charged separately.",
    },
    footnote:
      "Credit costs depend on the models involved and the length of the request. The pricing page has the current weights.",
    cta: "See pricing",
  },
  proof: {
    eyebrow: "How it works",
    title: "See the full workflow—not another feature list.",
    description:
      "One task, end to end: a prompt, three model answers, AI Review, and the next action.",
    workflowLabel: "Workflow overview",
    workflowTitle: "From one question to a clearer review",
    workflowBody:
      "The selected models answer in parallel. AI Review then groups their common ground, contradictions, missing points, and verification needs, so a follow-up or a share starts from something structured.",
    workflowDisclosure:
      "Illustrative diagram, not a product recording · no customer content · no provider endorsement",
    stages: [
      { title: "One question", caption: "Sent once to every selected model." },
      { title: "Parallel answers", caption: "Up to three answers, side by side." },
      { title: "AI Review", caption: "Common ground, contradictions, missing points, what to verify." },
      { title: "Next action", caption: "Follow up with one model, or share the result." },
    ],
    steps: [
      { title: "1. Ask once", description: "Choose up to three models and send one prompt or supported file." },
      { title: "2. Compare the answers", description: "Read different strengths side by side without copying between tabs." },
      { title: "3. Run AI Review", description: "Structure agreements, conflicts, omissions, and what to verify next." },
    ],
    terminologyNote:
      "AI Review is the product name; in the app the action itself reads “AI answer cross-review”.",
    reviewModesLabel: "Pick what the review should weigh",
    reviewModes: [
      "Balanced — agreement, differences, omissions and usefulness evenly",
      "Evidence — unsupported claims, conflicts and evidence gaps",
      "Action — practical next steps, trade-offs and risks",
    ],
    dualReviewerLabel: "Two independent reviewers",
    dualReviewer:
      "When a second reviewer from a different provider is available, the comparison runs twice independently and the review reports where the two reviewers agreed and where they did not.",
    casesTitle: "Three jobs where a second perspective matters",
    casesDescription:
      "Each example starts with a concrete artifact and ends with something reviewable. These are controlled product examples, not invented customer testimonials.",
    cases: [
      {
        title: "Cross-review a decision",
        description: "Compare launch, policy, or planning advice from several models.",
        result: "Outcome: agreements, conflicts, missing risks, and verification tasks in one view.",
        link: "See AI answer review",
      },
      {
        title: "Analyze a PDF or document",
        description: "Ask several models about the same 18-page brief instead of pasting excerpts into each one.",
        result: "Outcome: each model's reading of the same document, side by side.",
        link: "Explore file analysis",
      },
      {
        title: "Review code or a plan",
        description: "Compare a minimal patch, trade-offs, failure paths, and missing tests.",
        result: "Outcome: an implementation plan that still makes clear what must be tested.",
        link: "Compare AI models",
      },
    ],
    reviewBoundary:
      "AI Review compares only the supplied answers. It does not browse the web, prove facts, or declare a correct winner. When an item needs checking, you can run a separate web check on it from the review. Important claims still need current primary sources, testing, or qualified professional review.",
  },
  support: {
    title: "Keep the work moving after the comparison.",
    description:
      "Tomverse keeps the useful context around each answer, so a comparison can become a document, a follow-up, or a result your team can revisit.",
    items: [
      {
        title: "Files and real context",
        description: "Add images, PDFs, Office documents, text files, or supported Google Drive files when the source material matters.",
      },
      {
        title: "Targeted follow-up",
        description: "Pause the panels you are done with and keep asking one model, without losing the other answers or the original comparison.",
      },
      {
        title: "Projects and records",
        description: "Organize conversations into projects, search back through them, and keep a reusable record instead of rebuilding context across tabs.",
        condition: "Account required.",
      },
      {
        title: "Share and export",
        description: "Create a read-only share page, download a clean text record, or export your history as a text archive.",
        condition: "Account required. Share links can expire.",
      },
      {
        title: "Model Finder",
        description: "Answer two questions about the work and the priority, and get a starting model combination instead of guessing.",
        condition: "Account required.",
      },
      {
        title: "Bring your guest chats with you",
        description: "Conversations you started without an account can be imported when you create one, so a trial run is not thrown away.",
        condition: "Offered when you create an account.",
      },
    ],
    accountNote: "A free account is what turns a single comparison into a record you can come back to.",
    cta: "Create a free account",
  },
  catalogue: {
    title: "Compare models across leading providers",
    description:
      "One catalogue, one selection step. Pick the models that suit the question instead of opening a tab per provider.",
    providerNote: "{count} providers in the current catalogue.",
    planNote: "Which models you can select depends on your plan.",
    statusNote: "Model availability can change, so the live status page is the source of current service state.",
    modelFinderLead: "Not sure which AI fits your work?",
    modelFinderCta: "Get a one-minute recommendation after sign-up.",
    cta: "Explore all models",
    statusCta: "Live service status",
  },
  trust: {
    title: "Clear controls for private and shared work.",
    description:
      "Tomverse makes storage, locks, and sharing behavior visible. AI providers still receive the prompts needed to generate a response.",
    items: [
      {
        title: "Locked conversations",
        description: "Protect sensitive saved chats and require unlock verification before protected actions.",
        condition: "Account required.",
      },
      {
        title: "Read-only sharing",
        description: "Share a snapshot designed not to expose later conversation updates.",
        condition: "Account required. Share links can expire.",
      },
      {
        title: "Attachment limits",
        description: "File type, size, and per-message count limits apply to everything you attach.",
      },
    ],
    metricPeriod: "Last 30 days",
    comparisonMetric: "consented multi-model comparisons",
    fileMetric: "consented file workflows",
    metricDisclosure:
      "Only privacy-safe counts above the public threshold are shown, rounded down to the nearest ten.",
    safetyCta: "Read the safety and security overview",
  },
  pricing: {
    title: "Start free. Upgrade when the work grows.",
    description:
      "The homepage shows only the essentials. Model weights, credit examples, annual billing, add-on credits, and Fair Use details are explained on the pricing page.",
    plans: [
      { id: "free", title: "Free", blurb: "Light everyday use and trying advanced models." },
      { id: "pro", title: "Pro", blurb: "Regular multi-model comparison." },
      { id: "max", title: "Max", blurb: "Advanced models and long documents." },
    ],
    creditsLine: "{credits} monthly AI credits",
    creditsUnknown: "Monthly AI credits shown on the pricing page",
    monthly: "/ month",
    dailyLimitNote: "Free and Pro also pace monthly credits with a daily limit.",
    noDailyLimitNote: "Max has no daily credit limit.",
    deepResearchNote: "Deep Research is available from Pro.",
    detailsCta: "Compare plans and credit usage",
  },
  faqTitle: "Three quick questions",
  faqs: [
    {
      question: "Can I use Tomverse for free?",
      answer:
        "Yes. Without signing in, you can already compare 3 AI models side by side on the same question. Guest use has its own daily and monthly allowance, and a quick verification step before the first message. A Free account unlocks a broader model catalogue, higher usage limits, saved conversations, and other signed-in workflows within the plan limits.",
    },
    {
      question: "Which models can I compare?",
      answer:
        "The catalogue spans major providers including OpenAI, Anthropic, Google, and Perplexity, and changes as models are added or retired. The models page has the current list, and the live status page is the source of current service state.",
    },
    {
      question: "How is my data handled?",
      answer:
        "Tomverse applies attachment limits, locked-chat controls, and read-only share snapshots. Selected AI providers still receive the request content needed to answer; review the Safety page for the complete boundaries.",
    },
  ],
  ctaTitle: "One clearer view starts with one question.",
  ctaDescription: "Compare several AI answers, then use AI Review to decide what deserves a closer look.",
};

const ko: LandingCopy = {
  badge: "Tomverse Insight · 멀티 AI 비교 및 검토",
  brandNote: "Tomverse Insight는 Tomverse에서 제공하는 멀티 AI 비교 및 검토 경험입니다.",
  title: "한 번 질문하고,\n여러 AI 답변을 비교하세요.",
  description: "GPT, Claude, Gemini의 답변을 한 화면에서 비교하고,\nAI Review로 차이와 놓친 부분을 확인하세요.",
  primaryCta: "무료로 채팅 시작하기",
  signedInCta: "채팅 계속하기",
  heroSignupNote: "회원가입 없이 3개 모델로 바로 시작할 수 있습니다.",
  guestNote: "회원가입 없이 GPT, Claude, Gemini의 답변을 바로 비교해 보세요.",
  preview: {
    title: "하나의 질문, 여러 관점",
    count: "3개 모델",
    answers: ["명확한 다음 단계", "위험과 장단점", "간결한 실행 계획"],
    reviewTitle: "Tomverse AI Review",
    reviewItems: ["공통점", "모순", "누락", "추가 검증"],
    srDescription:
      "설명 이미지: 하나의 질문에 3개 모델이 나란히 답하고, AI Review 패널이 공통점·모순·누락·추가 검증 항목을 정리하는 화면입니다.",
  },
  compare: {
    eyebrow: "핵심 흐름",
    title: "질문 하나를 여러 모델에 동시에 보냅니다.",
    description:
      "모델을 고르고 질문을 한 번만 보내면 답변을 나란히 읽을 수 있습니다. 정리하는 방법은 두 가지입니다. 빠른 차이 요약, 그리고 본격적인 AI Review입니다.",
    stepsLabel: "진행 순서",
    steps: ["최대 3개 모델 선택", "한 번 질문하거나 파일 첨부", "비교·교차검토·후속 질문·공유"],
    quickSummary: {
      title: "빠른 차이 요약",
      description:
        "답변이 두 개 이상 모이면, 전부 정독하지 않고도 어디서 갈라지는지 AI가 요약해 줍니다. 정밀 검토가 아니라 빠르게 훑기 위한 기능입니다.",
      condition: "크레딧 소모가 적습니다. 사용 가능 횟수는 비회원과 로그인 상태에 따라 다릅니다.",
    },
    aiReviewBridge:
      "차이를 더 깊이 따져야 할 때는 AI Review가 같은 답변을 항목별로, 인용과 함께 더 멀리 끌고 갑니다.",
  },
  evidence: {
    eyebrow: "근거와 최신성",
    title: "비교에서 끝내지 않고, 근거까지 확인하세요.",
    description:
      "여러 답변을 비교하면 질문이 좁혀집니다. 그다음이 중요합니다. 그 주장이 어디에서 왔는지, 지금도 유효한지 확인하는 기능들입니다.",
    webSearch: {
      title: "웹 검색",
      description:
        "대화 단위로 웹 검색을 켜면 지원 모델이 최신 출처를 참고해 답하고 인용을 함께 돌려줍니다. 끄기, 최신 정보가 필요해 보일 때 제안받기, 매 턴 검색하기 중에서 고를 수 있습니다.",
      condition: "지원 범위는 모델마다 다릅니다. 추가 크레딧은 실제로 검색이 실행된 경우에만 사용됩니다.",
    },
    deepResearch: {
      title: "Deep Research",
      description:
        "하나의 질문을 여러 웹 출처에 걸친 확장 리서치로 보냅니다. 일반 채팅 답변이 아니라 별도의 장시간 작업으로 실행되며, 시작 전에 확인을 요청합니다.",
      condition: "Pro 플랜 이상에서 사용할 수 있고 크레딧을 사용합니다.",
    },
    sourceGrounding: {
      title: "근거 일치율",
      description:
        "AI Review는 비교 중인 답변을 인용합니다. 각 인용문을 원본 답변과 다시 대조해, 정확히 일치한 비율을 검토 결과와 함께 표시합니다.",
      condition: "인용이 원문과 맞는지를 측정하는 값이며, 사실 정확도나 주장이 참일 확률이 아닙니다.",
    },
    itemVerification: {
      title: "항목별 웹 확인",
      description:
        "검토 결과가 확인이 필요하다고 표시한 항목은 그 항목만 따로 웹으로 확인해, 최신 출처가 뒷받침하는지·반박하는지·판단 불가인지 볼 수 있습니다.",
      condition: "검토 생성과는 분리된 선택 작업입니다. 로그인 상태에서 검색 모델을 사용하며 크레딧이 별도로 듭니다.",
    },
    footnote:
      "크레딧 소모량은 사용한 모델과 요청 길이에 따라 달라집니다. 현재 차감 기준은 요금 페이지에 있습니다.",
    cta: "요금 보기",
  },
  proof: {
    eyebrow: "작동 방식",
    title: "기능 목록이 아니라 전체 작업 흐름을 확인하세요.",
    description: "하나의 작업을 처음부터 끝까지 봅니다. 질문, 3개 모델 답변, AI Review, 그리고 다음 작업입니다.",
    workflowLabel: "작업 흐름 개요",
    workflowTitle: "하나의 질문에서 더 명확한 검토까지",
    workflowBody:
      "선택한 모델이 동시에 답변합니다. 이어서 AI Review가 공통점, 모순, 누락과 추가 검증 항목을 묶어 주기 때문에, 후속 질문이나 공유를 정리된 결과에서 시작할 수 있습니다.",
    workflowDisclosure:
      "제품 녹화가 아닌 설명용 도식 · 고객 콘텐츠 없음 · 공급자 보증 아님",
    stages: [
      { title: "질문 하나", caption: "선택한 모든 모델에 한 번만 보냅니다." },
      { title: "동시 답변", caption: "최대 3개 답변을 나란히 봅니다." },
      { title: "AI Review", caption: "공통점, 모순, 누락, 확인할 항목을 정리합니다." },
      { title: "다음 작업", caption: "한 모델에만 이어서 묻거나 결과를 공유합니다." },
    ],
    steps: [
      { title: "1. 한 번 질문", description: "최대 3개 모델을 선택하고 질문 또는 지원되는 파일을 보냅니다." },
      { title: "2. 답변 비교", description: "여러 탭에 복사하지 않고 모델별 강점을 나란히 읽습니다." },
      { title: "3. AI Review", description: "합의, 충돌, 누락과 다음 검증 항목을 구조화합니다." },
    ],
    terminologyNote:
      "AI Review는 제품 이름이며, 앱 안에서는 같은 동작이 “AI 답변 교차검토”로 표시됩니다.",
    reviewModesLabel: "검토에서 무엇을 중점적으로 볼지 고르세요",
    reviewModes: [
      "균형 — 합의, 차이, 누락, 유용성을 고르게",
      "근거 — 근거 없는 주장, 충돌, 근거 공백 위주",
      "실행 — 실질적인 다음 단계, 장단점, 위험 위주",
    ],
    dualReviewerLabel: "독립적인 두 검토자",
    dualReviewer:
      "다른 공급자의 두 번째 검토 모델을 쓸 수 있을 때는 비교가 독립적으로 두 번 실행되고, 두 검토자가 어디에서 일치했고 어디에서 갈렸는지 함께 표시합니다.",
    casesTitle: "두 번째 관점이 유용한 세 가지 작업",
    casesDescription: "각 예시는 구체적인 자료에서 시작해 검토 가능한 결과로 끝납니다. 꾸며낸 고객 후기가 아닌 통제된 제품 예시입니다.",
    cases: [
      {
        title: "의사결정 교차검토",
        description: "여러 모델의 출시, 정책 또는 기획 조언을 비교합니다.",
        result: "결과: 합의, 충돌, 누락된 위험과 검증 작업을 한 화면에 정리합니다.",
        link: "AI 답변 교차검토 보기",
      },
      {
        title: "PDF·문서 분석",
        description: "발췌를 모델마다 붙여넣는 대신, 같은 18페이지 문서를 여러 모델에 함께 물어봅니다.",
        result: "결과: 같은 문서에 대한 모델별 해석을 나란히 확인합니다.",
        link: "파일 분석 살펴보기",
      },
      {
        title: "코드·계획 검토",
        description: "최소 패치, 장단점, 실패 경로와 누락 테스트를 비교합니다.",
        result: "결과: 반드시 테스트할 부분이 분명한 구현 계획을 만듭니다.",
        link: "AI 모델 비교하기",
      },
    ],
    reviewBoundary:
      "AI Review는 제공된 답변끼리만 비교합니다. 스스로 웹 검색을 하거나 사실을 확정하거나 정답을 고르지 않습니다. 확인이 필요한 항목은 검토 결과에서 웹 확인을 따로 실행할 수 있습니다. 중요한 주장은 최신 1차 출처, 테스트 또는 자격 있는 전문가를 통해 확인해야 합니다.",
  },
  support: {
    title: "비교한 뒤의 작업도 한 흐름으로 이어가세요.",
    description: "각 답변의 유용한 맥락을 유지해 비교 결과를 문서, 후속 질문 또는 팀이 다시 확인할 수 있는 기록으로 만듭니다.",
    items: [
      {
        title: "파일과 실제 맥락",
        description: "원본 자료가 중요할 때 이미지, PDF, Office 문서, 텍스트 또는 지원되는 Google Drive 파일을 추가하세요.",
      },
      {
        title: "특정 모델 후속 질문",
        description: "다 본 패널은 일시정지하고 한 모델에만 계속 질문하세요. 다른 답변과 원래 비교는 그대로 남습니다.",
      },
      {
        title: "프로젝트와 기록",
        description: "대화를 프로젝트로 정리하고 지난 대화를 검색해, 여러 탭에서 맥락을 다시 만들지 않아도 되는 기록을 유지하세요.",
        condition: "계정이 필요합니다.",
      },
      {
        title: "공유와 내보내기",
        description: "읽기 전용 공유 페이지를 만들거나, 깔끔한 텍스트 기록을 내려받거나, 대화 기록을 텍스트 아카이브로 내보낼 수 있습니다.",
        condition: "계정이 필요합니다. 공유 링크는 만료될 수 있습니다.",
      },
      {
        title: "Model Finder",
        description: "작업과 우선순위에 대한 두 가지 질문에 답하면, 추측 대신 시작할 모델 조합을 추천받습니다.",
        condition: "계정이 필요합니다.",
      },
      {
        title: "비회원 대화 가져오기",
        description: "계정 없이 시작한 대화도 가입할 때 가져올 수 있어, 체험한 내용이 사라지지 않습니다.",
        condition: "계정을 만들 때 안내합니다.",
      },
    ],
    accountNote: "무료 계정은 한 번의 비교를 다시 찾아볼 수 있는 기록으로 바꿔 줍니다.",
    cta: "무료 계정 만들기",
  },
  catalogue: {
    title: "주요 공급자의 모델을 한곳에서 비교",
    description: "카탈로그 하나, 선택 한 번. 공급자마다 탭을 여는 대신 질문에 맞는 모델을 고르세요.",
    providerNote: "현재 카탈로그의 공급자 {count}곳.",
    planNote: "선택할 수 있는 모델은 플랜에 따라 달라집니다.",
    statusNote: "모델 제공 상태는 바뀔 수 있으므로, 실시간 상태 페이지에서 현재 상태를 확인할 수 있습니다.",
    modelFinderLead: "어떤 AI가 내 작업에 맞는지 모르시겠나요?",
    modelFinderCta: "가입 후 1분 추천을 받아보세요.",
    cta: "전체 모델 보기",
    statusCta: "실시간 서비스 상태",
  },
  trust: {
    title: "비공개 작업과 공유를 위한 명확한 제어.",
    description: "저장, 잠금, 공유 동작을 분명히 보여드립니다. 답변 생성에 필요한 요청은 선택한 AI 공급자에게 전송됩니다.",
    items: [
      {
        title: "잠긴 대화",
        description: "민감한 저장 대화를 보호하고 중요한 작업 전에 잠금 해제 확인을 요구합니다.",
        condition: "계정이 필요합니다.",
      },
      {
        title: "읽기 전용 공유",
        description: "이후 대화 업데이트가 노출되지 않도록 설계된 스냅샷을 공유합니다.",
        condition: "계정이 필요합니다. 공유 링크는 만료될 수 있습니다.",
      },
      {
        title: "첨부파일 제한",
        description: "첨부하는 모든 파일에 형식, 용량, 메시지당 개수 제한이 적용됩니다.",
      },
    ],
    metricPeriod: "최근 30일",
    comparisonMetric: "동의 기반 멀티모델 비교",
    fileMetric: "동의 기반 파일 작업",
    metricDisclosure: "공개 기준을 넘은 개인정보 보호 집계만 10단위로 내림해 표시합니다.",
    safetyCta: "안전 및 보안 개요 보기",
  },
  pricing: {
    title: "무료로 시작하고 작업이 커질 때 업그레이드하세요.",
    description: "홈페이지에는 핵심만 표시합니다. 모델별 차감량, 크레딧 예시, 연간 결제, 추가 크레딧과 공정사용 정책은 요금 페이지에서 확인하세요.",
    plans: [
      { id: "free", title: "Free", blurb: "가벼운 일상 사용과 고급 모델 체험." },
      { id: "pro", title: "Pro", blurb: "일상적인 멀티모델 비교." },
      { id: "max", title: "Max", blurb: "고급 모델과 긴 문서 작업." },
    ],
    creditsLine: "월 {credits} AI 크레딧",
    creditsUnknown: "월 AI 크레딧은 요금 페이지에서 확인",
    monthly: "/ 월",
    dailyLimitNote: "Free와 Pro는 월 크레딧에 더해 일일 사용 한도가 적용됩니다.",
    noDailyLimitNote: "Max는 일일 크레딧 한도가 없습니다.",
    deepResearchNote: "Deep Research는 Pro부터 사용할 수 있습니다.",
    detailsCta: "플랜과 크레딧 사용량 비교",
  },
  faqTitle: "빠르게 확인하는 세 가지",
  faqs: [
    {
      question: "Tomverse를 무료로 사용할 수 있나요?",
      answer:
        "네. 로그인 없이도 3개의 AI 모델로 같은 질문에 대한 답변을 바로 비교해볼 수 있습니다. 비회원 이용에는 자체 일간·월간 사용량이 있고, 첫 메시지 전에 간단한 확인 절차를 거칩니다. Free 계정을 만들면 더 넓은 모델 카탈로그, 높은 사용량 한도, 대화 저장 및 로그인 전용 기능을 사용할 수 있습니다.",
    },
    {
      question: "어떤 모델을 비교할 수 있나요?",
      answer:
        "카탈로그는 OpenAI, Anthropic, Google, Perplexity를 비롯한 주요 공급자를 포함하며, 모델이 추가되거나 종료되면서 바뀝니다. 현재 목록은 모델 페이지에 있고, 실시간 상태 페이지에서 현재 서비스 상태를 확인할 수 있습니다.",
    },
    {
      question: "데이터는 어떻게 처리되나요?",
      answer:
        "첨부파일 제한, 대화 잠금, 읽기 전용 공유 스냅샷을 적용합니다. 선택한 AI 공급자는 답변에 필요한 요청 내용을 처리하므로 전체 범위는 안전 페이지에서 확인하세요.",
    },
  ],
  ctaTitle: "더 명확한 시야는 하나의 질문에서 시작됩니다.",
  ctaDescription: "여러 AI 답변을 비교한 뒤 AI Review로 더 살펴볼 부분을 빠르게 찾으세요.",
};

const zh: LandingCopy = {
  badge: "Tomverse Insight · 多 AI 比较与审查",
  brandNote: "Tomverse Insight 是 Tomverse 提供的多 AI 比较与审查体验。",
  title: "问一次，\n比较多个 AI 的回答。",
  description: "在一个页面比较 GPT、Claude 和 Gemini，再用 AI Review 找出差异与遗漏。",
  primaryCta: "免费开始聊天",
  signedInCta: "继续聊天",
  heroSignupNote: "无需注册，即可用 3 个模型直接开始。",
  guestNote: "无需注册，即可直接比较 GPT、Claude 和 Gemini 的回答。",
  preview: {
    title: "一个问题，多种视角",
    count: "3 个模型",
    answers: ["清晰的下一步", "风险与取舍", "简洁的执行计划"],
    reviewTitle: "Tomverse AI Review",
    reviewItems: ["共识", "矛盾", "遗漏", "下一步核实"],
    srDescription:
      "示意图：一个问题由三个模型并排回答，AI Review 面板整理共识、矛盾、遗漏和待核实项目。",
  },
  compare: {
    eyebrow: "核心流程",
    title: "一个问题同时发给多个模型。",
    description:
      "选好模型，只提问一次，就能并排阅读回答。整理方式有两种：快速差异摘要，或完整的 AI Review。",
    stepsLabel: "流程",
    steps: ["最多选择三个模型", "提问一次或附加文件", "比较、审查、追问或分享"],
    quickSummary: {
      title: "快速差异摘要",
      description:
        "有两个以上回答后，不必逐行细读，让 AI 概括它们在哪里出现分歧。它为快速浏览而设计，不是完整审查。",
      condition: "积分消耗较低。可用次数在未登录与登录状态下不同。",
    },
    aiReviewBridge: "当差异值得深入处理时，AI Review 会把同样的回答按板块、带引文地推进一步。",
  },
  evidence: {
    eyebrow: "依据与时效",
    title: "不只比较，还能核对。",
    description:
      "比较多个回答会收窄问题。接下来才是关键：这个说法从哪里来，现在是否仍然成立。",
    webSearch: {
      title: "网页搜索",
      description:
        "为某个对话开启网页搜索，支持的模型会参考当前来源作答并返回引用。可选择关闭、在问题看起来需要最新信息时给出建议，或每轮都搜索。",
      condition: "支持范围因模型而异。只有实际执行搜索时才会额外消耗积分。",
    },
    deepResearch: {
      title: "Deep Research",
      description:
        "把一个问题交给跨越多个网页来源的扩展研究。它作为独立的长时间任务运行，而不是普通聊天回复，并在开始前请你确认。",
      condition: "Pro 套餐及以上可用，会消耗积分。",
    },
    sourceGrounding: {
      title: "依据匹配率",
      description:
        "AI Review 会引用它正在比较的回答。每条引文都会与其来源回答重新比对，并随审查结果显示完全匹配的比例。",
      condition: "它衡量的是引文是否与原文一致，而不是事实准确度，也不是某个说法为真的概率。",
    },
    itemVerification: {
      title: "逐项网页核实",
      description:
        "对审查标记为需要核实的项目，可以只针对该项单独执行网页核实，查看当前来源是支持、反驳还是无法判定。",
      condition: "这是与审查生成分开的可选步骤。需登录，使用搜索模型，并单独计费。",
    },
    footnote: "积分消耗取决于所用模型和请求长度。当前权重见价格页。",
    cta: "查看价格",
  },
  proof: {
    eyebrow: "工作方式",
    title: "查看完整流程，而不是另一份功能清单。",
    description: "一个任务，从头到尾：提问、三个模型回答、AI Review，以及下一步操作。",
    workflowLabel: "流程概览",
    workflowTitle: "从一个问题到更清晰的审查",
    workflowBody:
      "所选模型并行作答。随后 AI Review 会整理共识、矛盾、遗漏和待核实项目，让追问或分享从结构化的结果开始。",
    workflowDisclosure: "说明性示意图，非产品录屏 · 无客户内容 · 非供应商背书",
    stages: [
      { title: "一个问题", caption: "只发送一次，送达每个所选模型。" },
      { title: "并行回答", caption: "最多三个回答并排显示。" },
      { title: "AI Review", caption: "整理共识、矛盾、遗漏与待核实项目。" },
      { title: "下一步", caption: "只向一个模型追问，或分享结果。" },
    ],
    steps: [
      { title: "1. 提问一次", description: "最多选择三个模型并发送问题或受支持的文件。" },
      { title: "2. 比较回答", description: "无需在多个标签页复制，即可并排阅读。" },
      { title: "3. 运行 AI Review", description: "整理一致、冲突、遗漏与下一步核实。" },
    ],
    terminologyNote: "AI Review 是产品名称；在应用中该操作显示为“AI 回答交叉审查”。",
    reviewModesLabel: "选择审查的侧重点",
    reviewModes: [
      "均衡 — 一致、差异、遗漏与实用性并重",
      "依据 — 侧重缺乏依据的说法、冲突与依据缺口",
      "行动 — 侧重可执行的下一步、取舍与风险",
    ],
    dualReviewerLabel: "两位独立审查者",
    dualReviewer:
      "当可以使用来自不同供应商的第二个审查模型时，比较会独立运行两次，并显示两位审查者在哪里一致、在哪里分歧。",
    casesTitle: "三个值得获得第二视角的任务",
    casesDescription: "每个示例都从具体材料开始，以可审查结果结束；这是受控产品示例，不是虚构客户评价。",
    cases: [
      {
        title: "交叉审查决策",
        description: "比较多个模型对发布、政策或规划的建议。",
        result: "结果：在一处查看共识、冲突、遗漏风险和核实任务。",
        link: "查看 AI 回答审查",
      },
      {
        title: "分析 PDF 或文档",
        description: "不必把摘录逐个粘贴给每个模型，直接就同一份 18 页文档向多个模型提问。",
        result: "结果：并排查看各模型对同一文档的解读。",
        link: "探索文件分析",
      },
      {
        title: "审查代码或计划",
        description: "比较最小补丁、取舍、失败路径和遗漏测试。",
        result: "结果：明确仍需测试内容的实施计划。",
        link: "比较 AI 模型",
      },
    ],
    reviewBoundary:
      "AI Review 只比较提供的回答。它不会自行浏览网页、判定事实，也不会选出唯一正确答案。需要核实的项目，可以在审查结果中单独执行网页核实。重要说法仍需通过最新一手来源、测试或专业人员核实。",
  },
  support: {
    title: "比较之后，继续完成工作。",
    description: "Tomverse 保留每个回答的上下文，让比较结果变成文档、追问或可复用的团队记录。",
    items: [
      {
        title: "文件与真实上下文",
        description: "需要原始材料时，可添加图片、PDF、Office 文档、文本或受支持的 Google Drive 文件。",
      },
      {
        title: "定向追问",
        description: "暂停看完的面板，只向一个模型继续提问，其他回答和原始比较都会保留。",
      },
      {
        title: "项目与记录",
        description: "按项目整理对话并检索历史，避免在多个标签页重复建立上下文。",
        condition: "需要账户。",
      },
      {
        title: "分享与导出",
        description: "创建只读分享页、下载整洁的文本记录，或将历史导出为文本存档。",
        condition: "需要账户。分享链接可能会过期。",
      },
      {
        title: "Model Finder",
        description: "回答关于任务与优先级的两个问题，直接获得起步的模型组合，不用靠猜。",
        condition: "需要账户。",
      },
      {
        title: "带走未登录时的对话",
        description: "未注册时开始的对话可以在创建账户时导入，试用内容不会白费。",
        condition: "创建账户时提供。",
      },
    ],
    accountNote: "免费账户能把一次比较变成日后可回看的记录。",
    cta: "创建免费账户",
  },
  catalogue: {
    title: "比较多个主流供应商的模型",
    description: "一个目录，一次选择。按问题挑选模型，而不是为每个供应商开一个标签页。",
    providerNote: "当前目录包含 {count} 家供应商。",
    planNote: "可选择的模型取决于你的套餐。",
    statusNote: "模型可用性可能变化，当前服务状态请以实时状态页为准。",
    modelFinderLead: "不确定哪种 AI 适合你的工作？",
    modelFinderCta: "注册后获取一分钟推荐。",
    cta: "浏览全部模型",
    statusCta: "实时服务状态",
  },
  trust: {
    title: "为私密与共享工作提供清晰控制。",
    description: "存储、锁定和共享行为清晰可见。所选 AI 供应商仍会处理生成回答所需的请求。",
    items: [
      {
        title: "锁定对话",
        description: "保护敏感对话，并在受保护操作前要求解锁验证。",
        condition: "需要账户。",
      },
      {
        title: "只读分享",
        description: "分享不会暴露后续对话更新的快照。",
        condition: "需要账户。分享链接可能会过期。",
      },
      {
        title: "附件限制",
        description: "所有附件都受文件类型、大小和单条消息数量限制。",
      },
    ],
    metricPeriod: "最近 30 天",
    comparisonMetric: "经同意的多模型比较",
    fileMetric: "经同意的文件工作流",
    metricDisclosure: "仅显示超过公开阈值且向下取整到十位的隐私安全统计。",
    safetyCta: "查看安全与保障说明",
  },
  pricing: {
    title: "免费开始，按需升级。",
    description: "首页只展示核心信息。模型权重、积分示例、年付、附加积分和公平使用政策请查看价格页。",
    plans: [
      { id: "free", title: "Free", blurb: "轻量日常使用与体验高级模型。" },
      { id: "pro", title: "Pro", blurb: "常规多模型比较。" },
      { id: "max", title: "Max", blurb: "高级模型与长文档。" },
    ],
    creditsLine: "每月 {credits} AI 积分",
    creditsUnknown: "每月 AI 积分见价格页",
    monthly: "/ 月",
    dailyLimitNote: "Free 与 Pro 的月度积分还受每日限额约束。",
    noDailyLimitNote: "Max 没有每日积分限额。",
    deepResearchNote: "Deep Research 从 Pro 起可用。",
    detailsCta: "比较套餐与积分用量",
  },
  faqTitle: "三个常见问题",
  faqs: [
    {
      question: "可以免费使用 Tomverse 吗？",
      answer:
        "可以。无需登录即可同时比较 3 个 AI 模型对同一问题的回答。未登录使用有各自的每日与每月额度，并在首条消息前需要完成一次快速验证。Free 账户可解锁更广泛的模型库、更高的使用额度、对话保存以及其他登录专属功能。",
    },
    {
      question: "可以比较哪些模型？",
      answer:
        "模型目录涵盖 OpenAI、Anthropic、Google、Perplexity 等主要供应商，并会随着模型上线或下线而变化。当前列表见模型页，当前服务状态请以实时状态页为准。",
    },
    {
      question: "数据如何处理？",
      answer:
        "Tomverse 提供附件限制、对话锁和只读分享快照。所选 AI 供应商仍会处理生成回答所需的内容；完整边界请查看安全页。",
    },
  ],
  ctaTitle: "一个问题，获得更清晰的全貌。",
  ctaDescription: "比较多个 AI 回答，再用 AI Review 找出值得深入核实的部分。",
};

const fr: LandingCopy = {
  badge: "Tomverse Insight · Comparaison et revue multi-IA",
  brandNote: "Tomverse Insight est l’expérience de comparaison et de revue multi-IA proposée par Tomverse.",
  title: "Posez une question.\nComparez plusieurs réponses IA.",
  description: "Comparez GPT, Claude et Gemini au même endroit, puis repérez les différences et les oublis avec AI Review.",
  primaryCta: "Commencer à discuter gratuitement",
  signedInCta: "Continuer la discussion",
  heroSignupNote: "Aucune inscription requise : commencez avec trois modèles.",
  guestNote: "Aucune inscription requise : comparez GPT, Claude et Gemini côte à côte.",
  preview: {
    title: "Une question, plusieurs points de vue",
    count: "3 modèles",
    answers: ["Prochaines étapes", "Risques et compromis", "Plan d’action concis"],
    reviewTitle: "Tomverse AI Review",
    reviewItems: ["Points communs", "Contradiction", "Omission", "À vérifier"],
    srDescription:
      "Illustration : une question traitée en parallèle par trois modèles, avec un panneau AI Review regroupant points communs, contradictions, omissions et éléments à vérifier.",
  },
  compare: {
    eyebrow: "Le cœur du flux",
    title: "Une question part vers plusieurs modèles à la fois.",
    description:
      "Choisissez les modèles, posez la question une seule fois et lisez les réponses côte à côte. Deux façons de les exploiter : un résumé rapide des différences, ou une revue AI Review complète.",
    stepsLabel: "Le déroulé",
    steps: ["Choisissez jusqu’à trois modèles", "Posez une question ou joignez un fichier", "Comparez, révisez, relancez ou partagez"],
    quickSummary: {
      title: "Résumé rapide des différences",
      description:
        "Dès que deux réponses sont là, faites résumer par l’IA les points de divergence, sans tout relire ligne à ligne. Conçu pour une lecture rapide, pas pour une revue complète.",
      condition: "Coût en crédits faible. Les quotas diffèrent entre usage invité et connecté.",
    },
    aiReviewBridge:
      "Quand les écarts méritent d’être creusés, AI Review reprend les mêmes réponses, section par section et avec citations.",
  },
  evidence: {
    eyebrow: "Preuves et actualité",
    title: "Des réponses vérifiables, pas seulement comparables.",
    description:
      "Comparer plusieurs réponses resserre la question. Voici les outils pour la suite : d’où vient une affirmation, et tient-elle toujours.",
    webSearch: {
      title: "Recherche web",
      description:
        "Activez la recherche web pour une conversation : les modèles compatibles répondent à partir de sources actuelles et renvoient des citations. Au choix : désactivée, suggérée quand la question semble dépendre de l’actualité, ou à chaque tour.",
      condition: "La prise en charge varie selon le modèle. Des crédits supplémentaires ne s’appliquent que si une recherche est réellement exécutée.",
    },
    deepResearch: {
      title: "Deep Research",
      description:
        "Envoyez une question vers une recherche étendue sur de nombreuses sources web. Elle s’exécute comme une tâche longue distincte, pas comme une réponse de chat, et demande confirmation avant de démarrer.",
      condition: "À partir du plan Pro. Consomme des crédits.",
    },
    sourceGrounding: {
      title: "Ancrage des citations",
      description:
        "AI Review cite les réponses qu’il compare. Chaque citation est recomparée à la réponse dont elle provient, et la part qui correspond exactement est affichée avec la revue.",
      condition: "Cela mesure la correspondance des citations, pas l’exactitude factuelle ni une probabilité de vérité.",
    },
    itemVerification: {
      title: "Vérification web par élément",
      description:
        "Pour un élément signalé comme à vérifier, lancez une vérification web sur ce seul élément et voyez si les sources actuelles le soutiennent, le contredisent ou ne tranchent pas.",
      condition: "Étape optionnelle, distincte de la revue elle-même. Compte connecté, modèle de recherche, facturation séparée.",
    },
    footnote:
      "Le coût en crédits dépend des modèles utilisés et de la longueur de la demande. Les poids actuels figurent sur la page Tarifs.",
    cta: "Voir les tarifs",
  },
  proof: {
    eyebrow: "Fonctionnement",
    title: "Voyez le flux complet, pas une nouvelle liste de fonctions.",
    description: "Une tâche de bout en bout : une question, trois réponses, AI Review, puis l’action suivante.",
    workflowLabel: "Vue d’ensemble du flux",
    workflowTitle: "D’une question à une revue plus claire",
    workflowBody:
      "Les modèles sélectionnés répondent en parallèle. AI Review regroupe ensuite accords, contradictions, omissions et vérifications, pour qu’une relance ou un partage parte d’un résultat structuré.",
    workflowDisclosure:
      "Schéma explicatif, pas un enregistrement du produit · aucun contenu client · aucune approbation de fournisseur",
    stages: [
      { title: "Une question", caption: "Envoyée une seule fois à chaque modèle choisi." },
      { title: "Réponses parallèles", caption: "Jusqu’à trois réponses côte à côte." },
      { title: "AI Review", caption: "Accords, contradictions, omissions, éléments à vérifier." },
      { title: "Action suivante", caption: "Relancer un seul modèle, ou partager le résultat." },
    ],
    steps: [
      { title: "1. Une seule question", description: "Choisissez jusqu’à trois modèles et envoyez un prompt ou fichier pris en charge." },
      { title: "2. Comparez", description: "Lisez les forces de chaque réponse côte à côte." },
      { title: "3. Lancez AI Review", description: "Structurez accords, conflits, omissions et vérifications." },
    ],
    terminologyNote:
      "AI Review est le nom produit ; dans l’application, l’action s’appelle « AI answer cross-review ».",
    reviewModesLabel: "Choisissez ce que la revue doit privilégier",
    reviewModes: [
      "Équilibré — accords, différences, omissions et utilité à parts égales",
      "Preuves — affirmations non étayées, conflits et lacunes de preuve",
      "Action — étapes concrètes, compromis et risques",
    ],
    dualReviewerLabel: "Deux relecteurs indépendants",
    dualReviewer:
      "Lorsqu’un second relecteur d’un autre fournisseur est disponible, la comparaison est exécutée deux fois de façon indépendante, et la revue indique où les deux relecteurs convergent ou divergent.",
    casesTitle: "Trois tâches où un second point de vue compte",
    casesDescription: "Chaque exemple part d’un élément concret et produit un résultat vérifiable, sans faux témoignage client.",
    cases: [
      {
        title: "Revoir une décision",
        description: "Comparez les conseils de lancement, politique ou planification.",
        result: "Résultat : accords, conflits, risques oubliés et vérifications dans une seule vue.",
        link: "Voir la revue des réponses",
      },
      {
        title: "Analyser un PDF",
        description: "Interrogez plusieurs modèles sur le même dossier de 18 pages au lieu de coller des extraits dans chacun.",
        result: "Résultat : la lecture de chaque modèle sur le même document, côte à côte.",
        link: "Explorer l’analyse de fichiers",
      },
      {
        title: "Revoir code ou plan",
        description: "Comparez correctif minimal, compromis, échecs et tests manquants.",
        result: "Résultat : un plan d’implémentation qui indique ce qui reste à tester.",
        link: "Comparer les modèles",
      },
    ],
    reviewBoundary:
      "AI Review compare uniquement les réponses fournies. Il ne navigue pas de lui-même, ne prouve pas les faits et ne désigne pas de gagnant. Pour un élément à vérifier, vous pouvez lancer une vérification web distincte depuis la revue. Les enjeux importants exigent des sources primaires à jour, des tests ou un avis qualifié.",
  },
  support: {
    title: "Poursuivez le travail après la comparaison.",
    description: "Tomverse conserve le contexte utile pour transformer une comparaison en document, relance ou résultat réutilisable.",
    items: [
      {
        title: "Fichiers et contexte réel",
        description: "Ajoutez images, PDF, documents Office, texte ou fichiers Google Drive pris en charge.",
      },
      {
        title: "Relance ciblée",
        description: "Mettez en pause les panneaux terminés et continuez avec un seul modèle, sans perdre les autres réponses ni la comparaison.",
      },
      {
        title: "Projets et archives",
        description: "Organisez les conversations en projets, effectuez des recherches dans l’historique et conservez un contexte réutilisable.",
        condition: "Compte requis.",
      },
      {
        title: "Partage et export",
        description: "Créez une page en lecture seule, téléchargez une trace texte propre ou exportez l’historique en archive texte.",
        condition: "Compte requis. Les liens de partage peuvent expirer.",
      },
      {
        title: "Model Finder",
        description: "Répondez à deux questions sur la tâche et la priorité pour obtenir une combinaison de modèles de départ.",
        condition: "Compte requis.",
      },
      {
        title: "Récupérez vos conversations invité",
        description: "Les conversations démarrées sans compte peuvent être importées à la création du compte.",
        condition: "Proposé à la création du compte.",
      },
    ],
    accountNote: "Un compte gratuit transforme une comparaison ponctuelle en trace consultable plus tard.",
    cta: "Créer un compte gratuit",
  },
  catalogue: {
    title: "Comparez les modèles des principaux fournisseurs",
    description: "Un seul catalogue, une seule sélection. Choisissez les modèles adaptés à la question plutôt qu’un onglet par fournisseur.",
    providerNote: "{count} fournisseurs dans le catalogue actuel.",
    planNote: "Les modèles sélectionnables dépendent de votre plan.",
    statusNote: "La disponibilité peut changer ; la page d’état fait foi pour l’état actuel du service.",
    modelFinderLead: "Vous ne savez pas quelle IA choisir ?",
    modelFinderCta: "Obtenez une recommandation en une minute après inscription.",
    cta: "Explorer tous les modèles",
    statusCta: "État du service en direct",
  },
  trust: {
    title: "Des contrôles clairs pour le travail privé et partagé.",
    description: "Le stockage, le verrouillage et le partage sont visibles. Les fournisseurs sélectionnés traitent la demande nécessaire à la réponse.",
    items: [
      {
        title: "Conversations verrouillées",
        description: "Protégez les conversations sensibles avant les actions à risque.",
        condition: "Compte requis.",
      },
      {
        title: "Partage en lecture seule",
        description: "Partagez un instantané qui n’expose pas les mises à jour ultérieures.",
        condition: "Compte requis. Les liens de partage peuvent expirer.",
      },
      {
        title: "Limites de pièces jointes",
        description: "Des limites de type, de taille et de nombre par message s’appliquent à toute pièce jointe.",
      },
    ],
    metricPeriod: "30 derniers jours",
    comparisonMetric: "comparaisons multi-modèles consenties",
    fileMetric: "flux fichiers consentis",
    metricDisclosure: "Seuls les comptes respectueux de la vie privée au-dessus du seuil public sont affichés, arrondis à la dizaine inférieure.",
    safetyCta: "Lire l’aperçu sécurité",
  },
  pricing: {
    title: "Commencez gratuitement, évoluez selon vos besoins.",
    description: "Les poids des modèles, exemples de crédits, paiements annuels, crédits additionnels et Fair Use sont détaillés sur la page Tarifs.",
    plans: [
      { id: "free", title: "Free", blurb: "Usage quotidien léger et essai de modèles avancés." },
      { id: "pro", title: "Pro", blurb: "Comparaison multi-modèles régulière." },
      { id: "max", title: "Max", blurb: "Modèles avancés et documents longs." },
    ],
    creditsLine: "{credits} crédits IA par mois",
    creditsUnknown: "Crédits IA mensuels indiqués sur la page Tarifs",
    monthly: "/ mois",
    dailyLimitNote: "Free et Pro encadrent aussi les crédits mensuels par une limite quotidienne.",
    noDailyLimitNote: "Max n’a pas de limite quotidienne de crédits.",
    deepResearchNote: "Deep Research est disponible à partir de Pro.",
    detailsCta: "Comparer les plans et crédits",
  },
  faqTitle: "Trois questions rapides",
  faqs: [
    {
      question: "Puis-je utiliser Tomverse gratuitement ?",
      answer:
        "Oui. Sans connexion, vous pouvez déjà comparer 3 modèles d’IA côte à côte sur la même question. L’usage invité dispose de ses propres quotas quotidien et mensuel, et d’une vérification rapide avant le premier message. Un compte Free débloque un catalogue plus large, des limites plus élevées, la sauvegarde des conversations et d’autres fonctionnalités réservées aux comptes connectés.",
    },
    {
      question: "Quels modèles puis-je comparer ?",
      answer:
        "Le catalogue couvre les principaux fournisseurs, dont OpenAI, Anthropic, Google et Perplexity, et évolue au fil des ajouts et retraits. La page Modèles contient la liste actuelle, et la page d’état fait foi pour l’état du service.",
    },
    {
      question: "Comment mes données sont-elles traitées ?",
      answer:
        "Tomverse applique limites de pièces jointes, verrouillage et instantanés en lecture seule. Les fournisseurs sélectionnés traitent toujours le contenu nécessaire à la réponse.",
    },
  ],
  ctaTitle: "Une vision plus claire commence par une question.",
  ctaDescription: "Comparez plusieurs réponses puis utilisez AI Review pour cibler ce qui mérite un examen approfondi.",
};

const de: LandingCopy = {
  badge: "Tomverse Insight · Multi-KI-Vergleich und -Prüfung",
  brandNote: "Tomverse Insight ist das Multi-KI-Vergleichs- und Prüferlebnis von Tomverse.",
  title: "Einmal fragen.\nAntworten mehrerer KIs vergleichen.",
  description: "Vergleichen Sie GPT, Claude und Gemini an einem Ort und erkennen Sie mit AI Review Unterschiede und Lücken.",
  primaryCta: "Kostenlos chatten",
  signedInCta: "Chat fortsetzen",
  heroSignupNote: "Keine Anmeldung nötig – starten Sie direkt mit drei Modellen.",
  guestNote: "Keine Anmeldung nötig – vergleichen Sie GPT, Claude und Gemini direkt nebeneinander.",
  preview: {
    title: "Eine Frage, mehrere Perspektiven",
    count: "3 Modelle",
    answers: ["Klare nächste Schritte", "Risiken und Abwägungen", "Kompakter Betriebsplan"],
    reviewTitle: "Tomverse AI Review",
    reviewItems: ["Gemeinsamkeit", "Widerspruch", "Lücke", "Zu prüfen"],
    srDescription:
      "Illustration: Eine Frage, die drei Modelle nebeneinander beantworten, mit einem AI-Review-Panel für Gemeinsamkeiten, Widersprüche, Lücken und Prüfbedarf.",
  },
  compare: {
    eyebrow: "Der Kernablauf",
    title: "Eine Frage geht gleichzeitig an mehrere Modelle.",
    description:
      "Modelle wählen, die Frage einmal senden, die Antworten nebeneinander lesen. Zwei Wege zur Auswertung: eine schnelle Unterschiedszusammenfassung oder ein vollständiges AI Review.",
    stepsLabel: "Der Ablauf",
    steps: ["Bis zu drei Modelle wählen", "Einmal fragen oder Datei anhängen", "Vergleichen, prüfen, nachfragen oder teilen"],
    quickSummary: {
      title: "Schnelle Unterschiedszusammenfassung",
      description:
        "Sobald zwei Antworten vorliegen, fasst die KI zusammen, wo sie auseinandergehen – ohne alles Zeile für Zeile zu lesen. Für den schnellen Überblick gedacht, nicht für die vollständige Prüfung.",
      condition: "Geringer Kreditverbrauch. Die Kontingente unterscheiden sich zwischen Gast- und angemeldeter Nutzung.",
    },
    aiReviewBridge:
      "Wenn die Unterschiede wirklich zählen, führt AI Review dieselben Antworten weiter – abschnittsweise und mit Zitaten.",
  },
  evidence: {
    eyebrow: "Belege und Aktualität",
    title: "Antworten, die sich prüfen lassen – nicht nur vergleichen.",
    description:
      "Mehrere Antworten zu vergleichen schärft die Frage. Diese Werkzeuge decken den Teil danach ab: Woher stammt eine Aussage, und gilt sie noch?",
    webSearch: {
      title: "Websuche",
      description:
        "Aktivieren Sie die Websuche für eine Unterhaltung, damit unterstützte Modelle mit aktuellen Quellen antworten und Zitate liefern. Wählbar: aus, ein Hinweis bei zeitkritischen Fragen, oder Suche in jedem Zug.",
      condition: "Die Unterstützung ist je Modell verschieden. Zusätzliche Kredite fallen nur an, wenn tatsächlich gesucht wird.",
    },
    deepResearch: {
      title: "Deep Research",
      description:
        "Schicken Sie eine Frage in eine erweiterte Recherche über viele Webquellen. Sie läuft als eigener Langzeitauftrag statt als normale Chatantwort und fragt vor dem Start nach einer Bestätigung.",
      condition: "Ab dem Pro-Plan. Verbraucht Kredite.",
    },
    sourceGrounding: {
      title: "Quellenabgleich",
      description:
        "AI Review zitiert die verglichenen Antworten. Jedes Zitat wird mit der Antwort abgeglichen, aus der es stammt, und der exakt übereinstimmende Anteil wird mit der Prüfung angezeigt.",
      condition: "Gemessen wird die Zitatübereinstimmung – nicht die inhaltliche Richtigkeit und keine Wahrscheinlichkeit, dass eine Aussage zutrifft.",
    },
    itemVerification: {
      title: "Web-Check je Punkt",
      description:
        "Für einen als prüfbedürftig markierten Punkt starten Sie einen separaten Web-Check nur zu diesem Punkt und sehen, ob aktuelle Quellen ihn stützen, widerlegen oder offen lassen.",
      condition: "Ein optionaler Schritt getrennt von der Prüfung selbst. Angemeldet, mit einem Suchmodell und separat abgerechnet.",
    },
    footnote:
      "Der Kreditverbrauch hängt von den genutzten Modellen und der Anfragelänge ab. Die aktuellen Gewichte stehen auf der Preisseite.",
    cta: "Preise ansehen",
  },
  proof: {
    eyebrow: "So funktioniert es",
    title: "Der ganze Ablauf statt einer weiteren Feature-Liste.",
    description: "Eine Aufgabe von Anfang bis Ende: Frage, drei Modellantworten, AI Review und die nächste Aktion.",
    workflowLabel: "Ablaufübersicht",
    workflowTitle: "Von einer Frage zur klareren Prüfung",
    workflowBody:
      "Die gewählten Modelle antworten parallel. AI Review bündelt danach Gemeinsamkeiten, Widersprüche, Lücken und Prüfbedarf, sodass Nachfrage oder Freigabe von einem strukturierten Ergebnis ausgehen.",
    workflowDisclosure:
      "Erklärende Grafik, keine Produktaufnahme · keine Kundeninhalte · keine Anbieterempfehlung",
    stages: [
      { title: "Eine Frage", caption: "Einmal an jedes gewählte Modell gesendet." },
      { title: "Parallele Antworten", caption: "Bis zu drei Antworten nebeneinander." },
      { title: "AI Review", caption: "Gemeinsamkeiten, Widersprüche, Lücken, Prüfpunkte." },
      { title: "Nächste Aktion", caption: "Bei einem Modell nachfragen oder das Ergebnis teilen." },
    ],
    steps: [
      { title: "1. Einmal fragen", description: "Bis zu drei Modelle wählen und Prompt oder unterstützte Datei senden." },
      { title: "2. Antworten vergleichen", description: "Stärken nebeneinander lesen, ohne Tabs zu kopieren." },
      { title: "3. AI Review starten", description: "Übereinstimmungen, Konflikte, Lücken und Prüfbedarf ordnen." },
    ],
    terminologyNote:
      "AI Review ist der Produktname; in der App heißt die Aktion „AI answer cross-review“.",
    reviewModesLabel: "Wählen Sie den Schwerpunkt der Prüfung",
    reviewModes: [
      "Ausgewogen — Übereinstimmung, Unterschiede, Lücken und Nutzen gleichermaßen",
      "Belege — unbelegte Aussagen, Konflikte und Belegkücken",
      "Handlung — konkrete nächste Schritte, Abwägungen und Risiken",
    ],
    dualReviewerLabel: "Zwei unabhängige Prüfer",
    dualReviewer:
      "Steht ein zweiter Prüfer eines anderen Anbieters zur Verfügung, läuft der Vergleich zweimal unabhängig, und die Prüfung zeigt, wo beide übereinstimmten und wo nicht.",
    casesTitle: "Drei Aufgaben, bei denen eine zweite Sicht hilft",
    casesDescription: "Jedes Beispiel beginnt mit einem konkreten Artefakt und endet prüfbar – ohne erfundene Kundenstimmen.",
    cases: [
      {
        title: "Entscheidung gegenprüfen",
        description: "Start-, Richtlinien- oder Planungsrat mehrerer Modelle vergleichen.",
        result: "Ergebnis: Gemeinsamkeiten, Konflikte, fehlende Risiken und Prüfaufgaben in einer Ansicht.",
        link: "KI-Antwortprüfung ansehen",
      },
      {
        title: "PDF oder Dokument analysieren",
        description: "Mehrere Modelle zum selben 18-seitigen Briefing befragen, statt Auszüge einzeln einzufügen.",
        result: "Ergebnis: die Lesart jedes Modells zum selben Dokument, nebeneinander.",
        link: "Dateianalyse entdecken",
      },
      {
        title: "Code oder Plan prüfen",
        description: "Minimalen Patch, Abwägungen, Fehlerpfade und fehlende Tests vergleichen.",
        result: "Ergebnis: Implementierungsplan mit klaren Testpflichten.",
        link: "KI-Modelle vergleichen",
      },
    ],
    reviewBoundary:
      "AI Review vergleicht nur gelieferte Antworten. Es durchsucht von sich aus nicht das Web, beweist keine Fakten und bestimmt keinen Gewinner. Für einen prüfbedürftigen Punkt können Sie aus der Prüfung heraus einen separaten Web-Check starten. Wichtige Aussagen brauchen weiterhin aktuelle Primärquellen, Tests oder qualifizierte Prüfung.",
  },
  support: {
    title: "Nach dem Vergleich direkt weiterarbeiten.",
    description: "Tomverse hält den nützlichen Kontext zusammen, damit aus dem Vergleich ein Dokument, eine Nachfrage oder ein wiederverwendbares Ergebnis wird.",
    items: [
      {
        title: "Dateien und echter Kontext",
        description: "Bilder, PDFs, Office-Dokumente, Text oder unterstützte Google-Drive-Dateien hinzufügen.",
      },
      {
        title: "Gezielte Nachfrage",
        description: "Fertige Panels pausieren und mit einem Modell weiterfragen, ohne die anderen Antworten oder den Vergleich zu verlieren.",
      },
      {
        title: "Projekte und Verlauf",
        description: "Unterhaltungen in Projekten organisieren, den Verlauf durchsuchen und Kontext wiederverwenden.",
        condition: "Konto erforderlich.",
      },
      {
        title: "Teilen und exportieren",
        description: "Schreibgeschützte Freigabe erstellen, einen sauberen Textverlauf laden oder den Verlauf als Textarchiv exportieren.",
        condition: "Konto erforderlich. Freigabelinks können ablaufen.",
      },
      {
        title: "Model Finder",
        description: "Zwei Fragen zu Aufgabe und Priorität beantworten und eine Modellkombination für den Start erhalten.",
        condition: "Konto erforderlich.",
      },
      {
        title: "Gast-Unterhaltungen mitnehmen",
        description: "Ohne Konto begonnene Unterhaltungen lassen sich beim Anlegen eines Kontos importieren.",
        condition: "Wird beim Anlegen eines Kontos angeboten.",
      },
    ],
    accountNote: "Ein kostenloses Konto macht aus einem einzelnen Vergleich einen Verlauf, den Sie wiederfinden.",
    cta: "Kostenloses Konto erstellen",
  },
  catalogue: {
    title: "Modelle führender Anbieter vergleichen",
    description: "Ein Katalog, ein Auswahlschritt. Modelle passend zur Frage wählen statt einen Tab pro Anbieter.",
    providerNote: "{count} Anbieter im aktuellen Katalog.",
    planNote: "Welche Modelle wählbar sind, hängt vom Plan ab.",
    statusNote: "Die Verfügbarkeit kann sich ändern; die Live-Statusseite zeigt den aktuellen Servicestand.",
    modelFinderLead: "Unsicher, welche KI passt?",
    modelFinderCta: "Nach der Anmeldung in einer Minute empfehlen lassen.",
    cta: "Alle Modelle ansehen",
    statusCta: "Live-Servicestatus",
  },
  trust: {
    title: "Klare Kontrollen für private und geteilte Arbeit.",
    description: "Speicherung, Sperren und Freigaben sind sichtbar. Ausgewählte KI-Anbieter verarbeiten die für die Antwort nötige Anfrage.",
    items: [
      {
        title: "Gesperrte Unterhaltungen",
        description: "Sensible Chats schützen und vor geschützten Aktionen entsperren.",
        condition: "Konto erforderlich.",
      },
      {
        title: "Schreibgeschütztes Teilen",
        description: "Einen Snapshot teilen, der spätere Aktualisierungen nicht offenlegt.",
        condition: "Konto erforderlich. Freigabelinks können ablaufen.",
      },
      {
        title: "Anhangslimits",
        description: "Für jeden Anhang gelten Grenzen für Dateityp, Größe und Anzahl pro Nachricht.",
      },
    ],
    metricPeriod: "Letzte 30 Tage",
    comparisonMetric: "eingewilligte Multi-Modell-Vergleiche",
    fileMetric: "eingewilligte Datei-Workflows",
    metricDisclosure: "Nur datenschutzfreundliche Werte über dem öffentlichen Schwellenwert werden angezeigt, auf Zehner abgerundet.",
    safetyCta: "Sicherheitsübersicht lesen",
  },
  pricing: {
    title: "Kostenlos starten, bei Bedarf erweitern.",
    description: "Modellgewichte, Kreditbeispiele, Jahreszahlung, Zusatzkredite und Fair Use stehen auf der Preisseite.",
    plans: [
      { id: "free", title: "Free", blurb: "Leichte Alltagsnutzung und Test fortgeschrittener Modelle." },
      { id: "pro", title: "Pro", blurb: "Regelmäßiger Multi-Modell-Vergleich." },
      { id: "max", title: "Max", blurb: "Fortgeschrittene Modelle und lange Dokumente." },
    ],
    creditsLine: "{credits} KI-Kredite pro Monat",
    creditsUnknown: "Monatliche KI-Kredite auf der Preisseite",
    monthly: "/ Monat",
    dailyLimitNote: "Free und Pro begrenzen die Monatskredite zusätzlich pro Tag.",
    noDailyLimitNote: "Max hat kein tägliches Kreditlimit.",
    deepResearchNote: "Deep Research ist ab Pro verfügbar.",
    detailsCta: "Pläne und Kreditverbrauch vergleichen",
  },
  faqTitle: "Drei kurze Fragen",
  faqs: [
    {
      question: "Kann ich Tomverse kostenlos nutzen?",
      answer:
        "Ja. Ohne Anmeldung können Sie bereits 3 KI-Modelle direkt bei derselben Frage vergleichen. Die Gastnutzung hat eigene Tages- und Monatskontingente und eine kurze Prüfung vor der ersten Nachricht. Ein Free-Konto schaltet einen breiteren Modellkatalog, höhere Nutzungslimits, gespeicherte Unterhaltungen und weitere Funktionen für angemeldete Nutzer frei.",
    },
    {
      question: "Welche Modelle kann ich vergleichen?",
      answer:
        "Der Katalog umfasst große Anbieter wie OpenAI, Anthropic, Google und Perplexity und ändert sich mit neuen oder abgekündigten Modellen. Die Modellseite führt die aktuelle Liste, die Statusseite den aktuellen Servicestand.",
    },
    {
      question: "Wie werden meine Daten verarbeitet?",
      answer:
        "Tomverse nutzt Anhangslimits, Chatsperren und schreibgeschützte Snapshots. Ausgewählte KI-Anbieter verarbeiten weiterhin die für Antworten nötigen Inhalte.",
    },
  ],
  ctaTitle: "Ein klarerer Blick beginnt mit einer Frage.",
  ctaDescription: "Mehrere Antworten vergleichen und mit AI Review gezielt tiefer prüfen.",
};

const es: LandingCopy = {
  badge: "Tomverse Insight · Comparación y revisión multi-IA",
  brandNote: "Tomverse Insight es la experiencia de comparación y revisión multi-IA de Tomverse.",
  title: "Pregunta una vez.\nCompara respuestas de varias IA.",
  description: "Compara GPT, Claude y Gemini en un solo lugar y usa AI Review para detectar diferencias y omisiones.",
  primaryCta: "Empezar a chatear gratis",
  signedInCta: "Continuar el chat",
  heroSignupNote: "No se requiere registro: empieza con tres modelos.",
  guestNote: "No se requiere registro: compara GPT, Claude y Gemini en paralelo.",
  preview: {
    title: "Una pregunta, varias perspectivas",
    count: "3 modelos",
    answers: ["Próximos pasos claros", "Riesgos y alternativas", "Plan operativo conciso"],
    reviewTitle: "Tomverse AI Review",
    reviewItems: ["Coincidencias", "Contradicción", "Omisión", "Por verificar"],
    srDescription:
      "Ilustración: una pregunta respondida en paralelo por tres modelos, con un panel de AI Review que agrupa coincidencias, contradicciones, omisiones y puntos por verificar.",
  },
  compare: {
    eyebrow: "El flujo principal",
    title: "Una pregunta va a varios modelos a la vez.",
    description:
      "Elige los modelos, envía la pregunta una sola vez y lee las respuestas en paralelo. Dos formas de aprovecharlas: un resumen rápido de diferencias o un AI Review completo.",
    stepsLabel: "El recorrido",
    steps: ["Elige hasta tres modelos", "Pregunta o adjunta un archivo", "Compara, revisa, continúa o comparte"],
    quickSummary: {
      title: "Resumen rápido de diferencias",
      description:
        "Con dos o más respuestas, deja que la IA resuma dónde divergen sin leerlas línea por línea. Está pensado para una lectura rápida, no para una revisión completa.",
      condition: "Bajo consumo de créditos. Los cupos difieren entre uso sin cuenta y con sesión iniciada.",
    },
    aiReviewBridge:
      "Cuando las diferencias merecen trabajarse a fondo, AI Review lleva esas mismas respuestas más lejos, sección a sección y con citas.",
  },
  evidence: {
    eyebrow: "Evidencia y actualidad",
    title: "Respuestas que puedes comprobar, no solo comparar.",
    description:
      "Comparar varias respuestas acota la pregunta. Estas son las herramientas para lo que viene después: de dónde salió una afirmación y si sigue vigente.",
    webSearch: {
      title: "Búsqueda web",
      description:
        "Activa la búsqueda web en una conversación para que los modelos compatibles respondan con fuentes actuales y devuelvan citas. Puedes elegir desactivada, sugerida cuando la pregunta parece depender de información reciente, o búsqueda en cada turno.",
      condition: "La compatibilidad varía según el modelo. Solo se consumen créditos extra si la búsqueda se ejecuta realmente.",
    },
    deepResearch: {
      title: "Deep Research",
      description:
        "Envía una pregunta a una investigación ampliada sobre muchas fuentes web. Se ejecuta como un trabajo largo aparte, no como una respuesta de chat, y pide confirmación antes de empezar.",
      condition: "Desde el plan Pro. Consume créditos.",
    },
    sourceGrounding: {
      title: "Anclaje de citas",
      description:
        "AI Review cita las respuestas que compara. Cada cita se contrasta con la respuesta de la que procede y se muestra el porcentaje que coincidió exactamente.",
      condition: "Mide la coincidencia de las citas, no la exactitud factual ni la probabilidad de que algo sea cierto.",
    },
    itemVerification: {
      title: "Verificación web por elemento",
      description:
        "Para un punto marcado como pendiente de verificar, ejecuta una comprobación web solo de ese punto y observa si las fuentes actuales lo respaldan, lo contradicen o no concluyen.",
      condition: "Paso opcional separado de la propia revisión. Con sesión iniciada, usa un modelo de búsqueda y se cobra aparte.",
    },
    footnote:
      "El consumo de créditos depende de los modelos usados y de la longitud de la solicitud. Los pesos actuales están en la página de precios.",
    cta: "Ver precios",
  },
  proof: {
    eyebrow: "Cómo funciona",
    title: "Mira el flujo completo, no otra lista de funciones.",
    description: "Una tarea de principio a fin: una pregunta, tres respuestas, AI Review y la siguiente acción.",
    workflowLabel: "Resumen del flujo",
    workflowTitle: "De una pregunta a una revisión más clara",
    workflowBody:
      "Los modelos elegidos responden en paralelo. Después AI Review agrupa acuerdos, contradicciones, omisiones y verificaciones, para que continuar o compartir parta de un resultado ordenado.",
    workflowDisclosure:
      "Diagrama ilustrativo, no una grabación del producto · sin contenido de clientes · sin respaldo de proveedores",
    stages: [
      { title: "Una pregunta", caption: "Se envía una sola vez a cada modelo elegido." },
      { title: "Respuestas en paralelo", caption: "Hasta tres respuestas, lado a lado." },
      { title: "AI Review", caption: "Acuerdos, contradicciones, omisiones y qué verificar." },
      { title: "Siguiente acción", caption: "Continuar con un modelo o compartir el resultado." },
    ],
    steps: [
      { title: "1. Pregunta una vez", description: "Elige hasta tres modelos y envía un prompt o archivo compatible." },
      { title: "2. Compara", description: "Lee las fortalezas de cada respuesta lado a lado." },
      { title: "3. Ejecuta AI Review", description: "Ordena acuerdos, conflictos, omisiones y verificaciones." },
    ],
    terminologyNote:
      "AI Review es el nombre de producto; dentro de la aplicación la acción aparece como «AI answer cross-review».",
    reviewModesLabel: "Elige en qué debe centrarse la revisión",
    reviewModes: [
      "Equilibrado — acuerdos, diferencias, omisiones y utilidad por igual",
      "Evidencia — afirmaciones sin respaldo, conflictos y vacíos de evidencia",
      "Acción — próximos pasos prácticos, alternativas y riesgos",
    ],
    dualReviewerLabel: "Dos revisores independientes",
    dualReviewer:
      "Cuando hay disponible un segundo revisor de otro proveedor, la comparación se ejecuta dos veces de forma independiente y la revisión indica dónde coincidieron y dónde no.",
    casesTitle: "Tres tareas donde importa una segunda perspectiva",
    casesDescription: "Cada ejemplo parte de un material concreto y termina en un resultado revisable, sin testimonios inventados.",
    cases: [
      {
        title: "Revisar una decisión",
        description: "Compara consejos de lanzamiento, política o planificación.",
        result: "Resultado: acuerdos, conflictos, riesgos omitidos y tareas de verificación en una vista.",
        link: "Ver revisión de respuestas",
      },
      {
        title: "Analizar PDF o documento",
        description: "Pregunta a varios modelos sobre el mismo informe de 18 páginas en lugar de pegar extractos en cada uno.",
        result: "Resultado: la lectura de cada modelo sobre el mismo documento, lado a lado.",
        link: "Explorar análisis de archivos",
      },
      {
        title: "Revisar código o plan",
        description: "Compara parche mínimo, alternativas, fallos y pruebas ausentes.",
        result: "Resultado: un plan que deja claro qué debe probarse.",
        link: "Comparar modelos",
      },
    ],
    reviewBoundary:
      "AI Review solo compara las respuestas dadas. No navega por su cuenta, no demuestra hechos ni elige un ganador. Para un punto que requiera comprobación, puedes ejecutar una verificación web aparte desde la revisión. Las afirmaciones importantes siguen requiriendo fuentes primarias actuales, pruebas o revisión profesional.",
  },
  support: {
    title: "Continúa el trabajo después de comparar.",
    description: "Tomverse conserva el contexto útil para convertir una comparación en documento, seguimiento o resultado reutilizable.",
    items: [
      {
        title: "Archivos y contexto real",
        description: "Añade imágenes, PDF, documentos Office, texto o archivos compatibles de Google Drive.",
      },
      {
        title: "Seguimiento dirigido",
        description: "Pausa los paneles que ya revisaste y sigue preguntando a un solo modelo sin perder las demás respuestas.",
      },
      {
        title: "Proyectos y registros",
        description: "Organiza conversaciones en proyectos, busca en el historial y conserva un contexto reutilizable.",
        condition: "Requiere cuenta.",
      },
      {
        title: "Compartir y exportar",
        description: "Crea una página de solo lectura, descarga un registro de texto limpio o exporta el historial como archivo de texto.",
        condition: "Requiere cuenta. Los enlaces compartidos pueden caducar.",
      },
      {
        title: "Model Finder",
        description: "Responde dos preguntas sobre la tarea y la prioridad y obtén una combinación de modelos para empezar.",
        condition: "Requiere cuenta.",
      },
      {
        title: "Lleva tus chats sin cuenta",
        description: "Las conversaciones iniciadas sin cuenta se pueden importar al crear una, así la prueba no se pierde.",
        condition: "Se ofrece al crear la cuenta.",
      },
    ],
    accountNote: "Una cuenta gratuita convierte una comparación puntual en un registro al que puedes volver.",
    cta: "Crear una cuenta gratis",
  },
  catalogue: {
    title: "Compara modelos de los principales proveedores",
    description: "Un catálogo, una selección. Elige los modelos que encajan con la pregunta en vez de abrir una pestaña por proveedor.",
    providerNote: "{count} proveedores en el catálogo actual.",
    planNote: "Los modelos que puedes seleccionar dependen de tu plan.",
    statusNote: "La disponibilidad puede cambiar; la página de estado en vivo indica el estado actual del servicio.",
    modelFinderLead: "¿No sabes qué IA encaja contigo?",
    modelFinderCta: "Recibe una recomendación de un minuto tras registrarte.",
    cta: "Explorar todos los modelos",
    statusCta: "Estado del servicio en vivo",
  },
  trust: {
    title: "Controles claros para trabajo privado y compartido.",
    description: "El almacenamiento, bloqueo y uso compartido son visibles. Los proveedores elegidos procesan la solicitud necesaria para responder.",
    items: [
      {
        title: "Conversaciones bloqueadas",
        description: "Protege chats sensibles antes de acciones protegidas.",
        condition: "Requiere cuenta.",
      },
      {
        title: "Compartir en solo lectura",
        description: "Comparte una instantánea que no expone cambios posteriores.",
        condition: "Requiere cuenta. Los enlaces compartidos pueden caducar.",
      },
      {
        title: "Límites de archivos",
        description: "Se aplican límites de tipo, tamaño y cantidad por mensaje a todo lo que adjuntes.",
      },
    ],
    metricPeriod: "Últimos 30 días",
    comparisonMetric: "comparaciones multimodelo consentidas",
    fileMetric: "flujos con archivos consentidos",
    metricDisclosure: "Solo se muestran conteos privados por encima del umbral público, redondeados a la decena inferior.",
    safetyCta: "Leer seguridad y protección",
  },
  pricing: {
    title: "Empieza gratis y mejora cuando crezca el trabajo.",
    description: "Los pesos por modelo, ejemplos de créditos, pago anual, créditos extra y Fair Use están en la página de precios.",
    plans: [
      { id: "free", title: "Free", blurb: "Uso diario ligero y prueba de modelos avanzados." },
      { id: "pro", title: "Pro", blurb: "Comparación multimodelo habitual." },
      { id: "max", title: "Max", blurb: "Modelos avanzados y documentos largos." },
    ],
    creditsLine: "{credits} créditos IA al mes",
    creditsUnknown: "Créditos IA mensuales en la página de precios",
    monthly: "/ mes",
    dailyLimitNote: "Free y Pro también reparten los créditos mensuales con un límite diario.",
    noDailyLimitNote: "Max no tiene límite diario de créditos.",
    deepResearchNote: "Deep Research está disponible desde Pro.",
    detailsCta: "Comparar planes y créditos",
  },
  faqTitle: "Tres preguntas rápidas",
  faqs: [
    {
      question: "¿Puedo usar Tomverse gratis?",
      answer:
        "Sí. Sin iniciar sesión ya puedes comparar 3 modelos de IA lado a lado en la misma pregunta. El uso sin cuenta tiene sus propios cupos diario y mensual, y una verificación rápida antes del primer mensaje. Una cuenta Free desbloquea un catálogo más amplio, límites más altos, conversaciones guardadas y otras funciones para usuarios con sesión iniciada.",
    },
    {
      question: "¿Qué modelos puedo comparar?",
      answer:
        "El catálogo incluye proveedores principales como OpenAI, Anthropic, Google y Perplexity, y cambia según se añaden o retiran modelos. La página de modelos tiene la lista actual y la página de estado indica el estado del servicio.",
    },
    {
      question: "¿Cómo se tratan mis datos?",
      answer:
        "Tomverse aplica límites de archivos, bloqueo de chats e instantáneas de solo lectura. Los proveedores elegidos siguen procesando el contenido necesario para responder.",
    },
  ],
  ctaTitle: "Una visión más clara empieza con una pregunta.",
  ctaDescription: "Compara varias respuestas y usa AI Review para decidir qué revisar con más detalle.",
};

const pt: LandingCopy = {
  badge: "Tomverse Insight · Comparação e revisão multi-IA",
  brandNote: "Tomverse Insight é a experiência de comparação e revisão multi-IA da Tomverse.",
  title: "Pergunte uma vez.\nCompare respostas de várias IAs.",
  description: "Compare GPT, Claude e Gemini em um só lugar e use o AI Review para encontrar diferenças e omissões.",
  primaryCta: "Começar a conversar grátis",
  signedInCta: "Continuar a conversa",
  heroSignupNote: "Não é necessário cadastro — comece com três modelos.",
  guestNote: "Não é necessário cadastro — compare GPT, Claude e Gemini lado a lado.",
  preview: {
    title: "Uma pergunta, várias perspectivas",
    count: "3 modelos",
    answers: ["Próximos passos claros", "Riscos e escolhas", "Plano operacional conciso"],
    reviewTitle: "Tomverse AI Review",
    reviewItems: ["Consenso", "Contradição", "Omissão", "A verificar"],
    srDescription:
      "Ilustração: uma pergunta respondida em paralelo por três modelos, com um painel de AI Review agrupando consensos, contradições, omissões e pontos a verificar.",
  },
  compare: {
    eyebrow: "O fluxo principal",
    title: "Uma pergunta vai para vários modelos ao mesmo tempo.",
    description:
      "Escolha os modelos, envie a pergunta uma única vez e leia as respostas lado a lado. Duas formas de aproveitá-las: um resumo rápido das diferenças ou um AI Review completo.",
    stepsLabel: "O percurso",
    steps: ["Escolha até três modelos", "Pergunte ou anexe um arquivo", "Compare, revise, continue ou compartilhe"],
    quickSummary: {
      title: "Resumo rápido das diferenças",
      description:
        "Com duas ou mais respostas, deixe a IA resumir onde elas divergem, sem ler tudo linha a linha. Foi feito para uma leitura rápida, não para uma revisão completa.",
      condition: "Baixo consumo de créditos. As cotas diferem entre uso sem conta e com login.",
    },
    aiReviewBridge:
      "Quando as diferenças merecem ser trabalhadas, o AI Review leva as mesmas respostas adiante, seção a seção e com citações.",
  },
  evidence: {
    eyebrow: "Evidência e atualidade",
    title: "Respostas que você pode conferir, não só comparar.",
    description:
      "Comparar várias respostas estreita a pergunta. Estas são as ferramentas para o que vem depois: de onde veio uma afirmação e se ela ainda se sustenta.",
    webSearch: {
      title: "Busca na web",
      description:
        "Ative a busca na web em uma conversa para que os modelos compatíveis respondam com fontes atuais e retornem citações. Escolha entre desligada, sugerida quando a pergunta parece depender de informação recente, ou busca a cada turno.",
      condition: "O suporte varia por modelo. Créditos extras só são usados quando a busca realmente acontece.",
    },
    deepResearch: {
      title: "Deep Research",
      description:
        "Envie uma pergunta para uma pesquisa estendida por muitas fontes da web. Ela roda como um trabalho longo à parte, não como uma resposta de chat, e pede confirmação antes de começar.",
      condition: "A partir do plano Pro. Usa créditos.",
    },
    sourceGrounding: {
      title: "Ancoragem das citações",
      description:
        "O AI Review cita as respostas que está comparando. Cada citação é confrontada com a resposta de origem, e a proporção que corresponde exatamente aparece junto da revisão.",
      condition: "Mede a correspondência das citações — não a exatidão factual nem a probabilidade de algo ser verdadeiro.",
    },
    itemVerification: {
      title: "Verificação web por item",
      description:
        "Para um item marcado como a verificar, execute uma checagem web apenas desse item e veja se as fontes atuais o sustentam, contradizem ou são inconclusivas.",
      condition: "Etapa opcional separada da própria revisão. Com login, usa um modelo de busca e é cobrada à parte.",
    },
    footnote:
      "O consumo de créditos depende dos modelos usados e do tamanho da solicitação. Os pesos atuais estão na página de preços.",
    cta: "Ver preços",
  },
  proof: {
    eyebrow: "Como funciona",
    title: "Veja o fluxo completo, não outra lista de recursos.",
    description: "Uma tarefa do início ao fim: uma pergunta, três respostas, AI Review e a próxima ação.",
    workflowLabel: "Visão geral do fluxo",
    workflowTitle: "De uma pergunta a uma revisão mais clara",
    workflowBody:
      "Os modelos escolhidos respondem em paralelo. Em seguida o AI Review agrupa consensos, contradições, omissões e verificações, para que continuar ou compartilhar parta de um resultado organizado.",
    workflowDisclosure:
      "Diagrama ilustrativo, não uma gravação do produto · sem conteúdo de clientes · sem endosso de provedores",
    stages: [
      { title: "Uma pergunta", caption: "Enviada uma só vez a cada modelo escolhido." },
      { title: "Respostas paralelas", caption: "Até três respostas, lado a lado." },
      { title: "AI Review", caption: "Consensos, contradições, omissões e o que verificar." },
      { title: "Próxima ação", caption: "Continuar com um modelo ou compartilhar o resultado." },
    ],
    steps: [
      { title: "1. Pergunte uma vez", description: "Escolha até três modelos e envie um prompt ou arquivo compatível." },
      { title: "2. Compare", description: "Leia os pontos fortes de cada resposta lado a lado." },
      { title: "3. Execute AI Review", description: "Organize acordos, conflitos, omissões e verificações." },
    ],
    terminologyNote:
      "AI Review é o nome do produto; dentro do aplicativo a ação aparece como “AI answer cross-review”.",
    reviewModesLabel: "Escolha o foco da revisão",
    reviewModes: [
      "Equilibrado — acordos, diferenças, omissões e utilidade por igual",
      "Evidência — afirmações sem apoio, conflitos e lacunas de evidência",
      "Ação — próximos passos práticos, escolhas e riscos",
    ],
    dualReviewerLabel: "Dois revisores independentes",
    dualReviewer:
      "Quando há um segundo revisor de outro provedor disponível, a comparação roda duas vezes de forma independente e a revisão mostra onde os dois concordaram e onde não.",
    casesTitle: "Três tarefas em que uma segunda perspectiva importa",
    casesDescription: "Cada exemplo começa com um material concreto e termina com um resultado revisável, sem depoimentos inventados.",
    cases: [
      {
        title: "Revisar uma decisão",
        description: "Compare orientações de lançamento, política ou planejamento.",
        result: "Resultado: consensos, conflitos, riscos omitidos e verificações em uma tela.",
        link: "Ver revisão de respostas",
      },
      {
        title: "Analisar PDF ou documento",
        description: "Pergunte a vários modelos sobre o mesmo relatório de 18 páginas em vez de colar trechos em cada um.",
        result: "Resultado: a leitura de cada modelo sobre o mesmo documento, lado a lado.",
        link: "Explorar análise de arquivos",
      },
      {
        title: "Revisar código ou plano",
        description: "Compare patch mínimo, escolhas, falhas e testes ausentes.",
        result: "Resultado: um plano que deixa claro o que ainda precisa ser testado.",
        link: "Comparar modelos",
      },
    ],
    reviewBoundary:
      "O AI Review compara apenas as respostas fornecidas. Ele não navega por conta própria, não prova fatos nem escolhe um vencedor. Para um item que precise de checagem, você pode executar uma verificação web separada a partir da revisão. Afirmações importantes continuam exigindo fontes primárias atuais, testes ou revisão profissional.",
  },
  support: {
    title: "Continue o trabalho depois da comparação.",
    description: "O Tomverse mantém o contexto útil para transformar uma comparação em documento, acompanhamento ou resultado reutilizável.",
    items: [
      {
        title: "Arquivos e contexto real",
        description: "Adicione imagens, PDFs, documentos Office, texto ou arquivos compatíveis do Google Drive.",
      },
      {
        title: "Acompanhamento direcionado",
        description: "Pause os painéis já lidos e continue perguntando a um único modelo, sem perder as outras respostas.",
      },
      {
        title: "Projetos e registros",
        description: "Organize conversas por projeto, pesquise no histórico e mantenha contexto reutilizável.",
        condition: "Requer conta.",
      },
      {
        title: "Compartilhar e exportar",
        description: "Crie uma página somente leitura, baixe um registro de texto limpo ou exporte o histórico como arquivo de texto.",
        condition: "Requer conta. Links de compartilhamento podem expirar.",
      },
      {
        title: "Model Finder",
        description: "Responda duas perguntas sobre a tarefa e a prioridade e receba uma combinação de modelos para começar.",
        condition: "Requer conta.",
      },
      {
        title: "Leve suas conversas sem conta",
        description: "Conversas iniciadas sem conta podem ser importadas ao criar uma, então o teste não é perdido.",
        condition: "Oferecido ao criar a conta.",
      },
    ],
    accountNote: "Uma conta gratuita transforma uma comparação isolada em um registro ao qual você pode voltar.",
    cta: "Criar uma conta grátis",
  },
  catalogue: {
    title: "Compare modelos dos principais provedores",
    description: "Um catálogo, uma seleção. Escolha os modelos adequados à pergunta em vez de abrir uma aba por provedor.",
    providerNote: "{count} provedores no catálogo atual.",
    planNote: "Os modelos que você pode selecionar dependem do seu plano.",
    statusNote: "A disponibilidade pode mudar; a página de status ao vivo indica o estado atual do serviço.",
    modelFinderLead: "Não sabe qual IA combina com seu trabalho?",
    modelFinderCta: "Receba uma recomendação de um minuto após criar a conta.",
    cta: "Explorar todos os modelos",
    statusCta: "Status do serviço ao vivo",
  },
  trust: {
    title: "Controles claros para trabalho privado e compartilhado.",
    description: "Armazenamento, bloqueio e compartilhamento ficam visíveis. Os provedores escolhidos processam a solicitação necessária para responder.",
    items: [
      {
        title: "Conversas bloqueadas",
        description: "Proteja chats sensíveis antes de ações protegidas.",
        condition: "Requer conta.",
      },
      {
        title: "Compartilhamento somente leitura",
        description: "Compartilhe um snapshot que não expõe atualizações posteriores.",
        condition: "Requer conta. Links de compartilhamento podem expirar.",
      },
      {
        title: "Limites de anexos",
        description: "Limites de tipo, tamanho e quantidade por mensagem valem para tudo o que você anexa.",
      },
    ],
    metricPeriod: "Últimos 30 dias",
    comparisonMetric: "comparações multimodelo consentidas",
    fileMetric: "fluxos com arquivos consentidos",
    metricDisclosure: "Somente contagens seguras acima do limite público são exibidas, arredondadas para baixo à dezena.",
    safetyCta: "Ler visão geral de segurança",
  },
  pricing: {
    title: "Comece grátis e evolua quando o trabalho crescer.",
    description: "Pesos por modelo, exemplos de créditos, cobrança anual, créditos extras e Fair Use estão na página de preços.",
    plans: [
      { id: "free", title: "Free", blurb: "Uso diário leve e teste de modelos avançados." },
      { id: "pro", title: "Pro", blurb: "Comparações multimodelo regulares." },
      { id: "max", title: "Max", blurb: "Modelos avançados e documentos longos." },
    ],
    creditsLine: "{credits} créditos de IA por mês",
    creditsUnknown: "Créditos de IA mensais na página de preços",
    monthly: "/ mês",
    dailyLimitNote: "Free e Pro também distribuem os créditos mensais com um limite diário.",
    noDailyLimitNote: "O Max não tem limite diário de créditos.",
    deepResearchNote: "O Deep Research está disponível a partir do Pro.",
    detailsCta: "Comparar planos e créditos",
  },
  faqTitle: "Três perguntas rápidas",
  faqs: [
    {
      question: "Posso usar o Tomverse gratuitamente?",
      answer:
        "Sim. Sem entrar, você já pode comparar 3 modelos de IA lado a lado na mesma pergunta. O uso sem conta tem cotas diária e mensal próprias e uma verificação rápida antes da primeira mensagem. Uma conta Free desbloqueia um catálogo mais amplo, limites maiores, conversas salvas e outros recursos para quem está conectado.",
    },
    {
      question: "Quais modelos posso comparar?",
      answer:
        "O catálogo inclui os principais provedores, como OpenAI, Anthropic, Google e Perplexity, e muda conforme modelos entram ou saem. A página de modelos traz a lista atual e a página de status indica o estado do serviço.",
    },
    {
      question: "Como meus dados são tratados?",
      answer:
        "O Tomverse aplica limites de anexos, bloqueio e snapshots somente leitura. Os provedores escolhidos continuam processando o conteúdo necessário para responder.",
    },
  ],
  ctaTitle: "Uma visão mais clara começa com uma pergunta.",
  ctaDescription: "Compare várias respostas e use o AI Review para decidir o que merece análise mais profunda.",
};

export const landingCopy: Record<Language, LandingCopy> = {
  en,
  ko,
  zh,
  fr,
  de,
  es,
  pt,
};

export const getLandingCopy = (lang: Language): LandingCopy =>
  landingCopy[lang] ?? landingCopy.en;

/** `{token}` substitution, matching the interpolation style used across the app. */
export const interpolate = (
  template: string,
  values: Record<string, string | number>
) =>
  Object.entries(values).reduce(
    (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
    template
  );
