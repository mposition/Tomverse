"use client";

import Image from "next/image";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  ArrowRight,
  CheckCircle2,
  Code2,
  FileText,
  PenLine,
  Scale,
  Sparkles,
} from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { trackProductEvent } from "@/lib/productAnalyticsClient";

type TaskRow = {
  task: string;
  gpt: string;
  claude: string;
  decision: string;
};

type GuideCopy = {
  jumpLabel: string;
  jumpLinks: Array<{ label: string; href: string }>;
  scopeEyebrow: string;
  scopeTitle: string;
  reviewedLabel: string;
  reviewedDate: string;
  modelsLabel: string;
  scopeNote: string;
  resultsTitle: string;
  resultsBody: string;
  taskHeader: string;
  gptHeader: string;
  claudeHeader: string;
  decisionHeader: string;
  tasks: TaskRow[];
  resultTitle: string;
  resultBody: string;
  samplePromptLabel: string;
  samplePrompt: string;
  gptResult: string;
  claudeResult: string;
  resultTakeaway: string;
  resultDisclaimer: string;
  methodTitle: string;
  methodBody: string;
  methodSteps: string[];
  screenTitle: string;
  screenBody: string;
  screenPrompt: string;
  screenCaption: string;
  promptsTitle: string;
  promptsBody: string;
  promptExamples: Array<{ label: string; prompt: string }>;
  fitTitle: string;
  fitCards: Array<{ title: string; body: string }>;
  faqTitle: string;
  faqs: Array<{ question: string; answer: string }>;
  relatedTitle: string;
  relatedLinks: Array<{ label: string; href: string; body: string }>;
  ctaEyebrow: string;
  ctaTitle: string;
  ctaBody: string;
  ctaLabel: string;
  signInNote: string;
  independentNotice: string;
};

const englishGuide: GuideCopy = {
  jumpLabel: "In this guide",
  jumpLinks: [
    { label: "Task comparison", href: "#task-comparison" },
    { label: "Methodology", href: "#methodology" },
    { label: "Prompt examples", href: "#prompt-examples" },
    { label: "FAQ", href: "#comparison-faq" },
  ],
  scopeEyebrow: "Review scope",
  scopeTitle: "A practical, repeatable comparison—not a permanent winner",
  reviewedLabel: "Reviewed",
  reviewedDate: "14 July 2026",
  modelsLabel: "Tomverse models shown",
  scopeNote:
    "The page uses GPT-5.4 mini and Claude Haiku 4.5 as the accessible comparison pair currently configured in Tomverse. Provider updates, prompts, sampling, tools, and context can change an individual result.",
  resultsTitle: "ChatGPT vs Claude by task",
  resultsBody:
    "These are qualitative editorial patterns to help you design a fair test. They are not vendor benchmark scores or a promise that every response will behave the same way.",
  taskHeader: "Work type",
  gptHeader: "What to inspect in GPT",
  claudeHeader: "What to inspect in Claude",
  decisionHeader: "How to decide",
  tasks: [
    {
      task: "Writing",
      gpt: "Check concise structure, format control, and how quickly a draft responds to revision instructions.",
      claude: "Check sustained tone, natural transitions, and coherence across a longer draft.",
      decision: "Compare edit distance using a real sample of your brand voice.",
    },
    {
      task: "Coding",
      gpt: "Inspect scoped patches, implementation alternatives, and whether the proposed tests cover the change.",
      claude: "Inspect explanations of trade-offs and whether broader code context is reflected in the review.",
      decision: "Run the code and tests; correctness matters more than presentation.",
    },
    {
      task: "Long documents",
      gpt: "Check whether narrow questions and an explicit output schema reduce omissions.",
      claude: "Check continuity across sections and whether important qualifications survive compression.",
      decision: "Verify citations, numbers, omissions, and the actual context limits in use.",
    },
    {
      task: "Summarization",
      gpt: "Check scan-friendly hierarchy and whether the response reaches the requested level of compression.",
      claude: "Check nuance, connective context, and whether caveats remain visible.",
      decision: "Choose based on concise action points versus contextual fidelity.",
    },
    {
      task: "Instruction following",
      gpt: "Use explicit formats and a constraint checklist, then audit each requirement.",
      claude: "Use detailed natural-language constraints and check the cohesion of the final answer.",
      decision: "Define acceptance criteria before testing and rerun more than once.",
    },
  ],
  resultTitle: "Example comparison outcome",
  resultBody:
    "A useful result is not simply “which answer sounds better.” Record what each response preserved, missed, and made easier to verify.",
  samplePromptLabel: "Same prompt",
  samplePrompt:
    "Rewrite this 120-word customer update as a 60-word executive brief. Preserve every date and risk. Return exactly three bullets, followed by one recommended action.",
  gptResult:
    "The structured result was easy to audit against bullet count, dates, and the requested action. The main review focus was whether aggressive compression removed useful context.",
  claudeResult:
    "The result retained explanatory context and a natural executive tone. The main review focus was exact length and whether every formatting constraint was followed.",
  resultTakeaway:
    "Takeaway: GPT and Claude can both complete the task; the better result is the one that passes your pre-written acceptance criteria with less correction.",
  resultDisclaimer:
    "This is a shortened editorial review pattern, not a verbatim live-model transcript. Use the preselected CTA below to generate a current result with the same prompt.",
  methodTitle: "Comparison methodology",
  methodBody:
    "A fair comparison controls the input and records enough context for someone else to repeat the test.",
  methodSteps: [
    "Send the same prompt, attachment, language, and output constraints to both models.",
    "Define factual accuracy, completeness, format, tone, and verification criteria before reading the answers.",
    "Review full responses, independently verify consequential claims, and run executable code or tests.",
    "Record the exact model names and review date; repeat representative tasks because responses are nondeterministic.",
  ],
  screenTitle: "What the Tomverse comparison screen looks like",
  screenBody:
    "Both responses stay beside the same prompt, so differences in structure, omissions, and follow-up behavior are easier to inspect.",
  screenPrompt: "Summarize the launch risks in exactly three bullets and recommend one next action.",
  screenCaption:
    "Recreated from the current Tomverse side-by-side interface. Response text is shortened for readability; model availability is shown separately on the status page.",
  promptsTitle: "Prompts you can copy and compare",
  promptsBody:
    "Replace the bracketed context with your own material and keep the acceptance criteria unchanged for both models.",
  promptExamples: [
    {
      label: "Writing",
      prompt: "Rewrite [draft] for [audience] in 120 words. Keep every fact, remove hype, and finish with one clear call to action.",
    },
    {
      label: "Coding",
      prompt: "Review [code] for correctness, security, and maintainability. Return: issues by severity, a minimal patch, and tests that would fail before the fix.",
    },
    {
      label: "Long document",
      prompt: "Using only [document], list the five decisions, their owners, dates, and unresolved risks. Quote the section heading supporting each item.",
    },
    {
      label: "Instruction following",
      prompt: "Answer in exactly four bullets. Each bullet must be under 18 words, include one verb, and contain no introductory sentence.",
    },
  ],
  fitTitle: "Which model is a better fit for you?",
  fitCards: [
    {
      title: "Start with GPT when…",
      body: "your workflow rewards compact structure, iterative revisions, explicit output formats, or implementation-focused technical work.",
    },
    {
      title: "Start with Claude when…",
      body: "your workflow rewards sustained tone, contextual explanation, long-form editorial flow, or careful review of a large brief.",
    },
    {
      title: "Compare both when…",
      body: "the task is consequential, subjective, unfamiliar, or expensive enough that a second independent approach is valuable.",
    },
  ],
  faqTitle: "ChatGPT vs Claude FAQ",
  faqs: [
    {
      question: "Is ChatGPT better than Claude?",
      answer: "There is no task-independent winner. Compare the exact models available to you using your real prompt and pre-defined acceptance criteria.",
    },
    {
      question: "Which is better for coding?",
      answer: "Both can help with coding. Evaluate whether the code runs, tests pass, security issues are addressed, and the patch fits your repository—not how confident the explanation sounds.",
    },
    {
      question: "Which is better for long documents?",
      answer: "The answer depends on document size, extractability, model context limits, and the question. Verify citations, figures, exclusions, and conclusions against the source file.",
    },
    {
      question: "Does the same prompt make the comparison perfectly fair?",
      answer: "It improves comparability, but provider system instructions, tools, context handling, and model updates can still differ. Record these limits in the review.",
    },
    {
      question: "Is Tomverse affiliated with OpenAI or Anthropic?",
      answer: "No. Tomverse is an independent multi-model workspace and is not affiliated with or endorsed by OpenAI or Anthropic.",
    },
  ],
  relatedTitle: "Continue comparing",
  relatedLinks: [
    { label: "Compare AI models", href: "/compare-ai-models", body: "Build a repeatable comparison across more providers." },
    { label: "AI file analysis", href: "/ai-for-file-analysis", body: "Compare models using PDFs, Office files, and images." },
    { label: "Browse available models", href: "/models", body: "Check usage classes, base credit charges, and availability." },
  ],
  ctaEyebrow: "Run the same test",
  ctaTitle: "Compare GPT-5.4 mini and Claude Haiku 4.5 side by side",
  ctaBody:
    "The models and sample prompt are preselected. Sign-in is required for multi-model comparison, files, saving, and sharing.",
  ctaLabel: "Compare the same prompt",
  signInNote: "You will sign in first, then return to the prepared comparison.",
  independentNotice:
    "Tomverse is an independent service. ChatGPT, GPT, Claude, OpenAI, and Anthropic names and trademarks belong to their respective owners.",
};

const koreanGuide: GuideCopy = {
  jumpLabel: "이 가이드의 구성",
  jumpLinks: [
    { label: "업무별 비교", href: "#task-comparison" },
    { label: "비교 방법론", href: "#methodology" },
    { label: "프롬프트 예제", href: "#prompt-examples" },
    { label: "FAQ", href: "#comparison-faq" },
  ],
  scopeEyebrow: "검토 범위",
  scopeTitle: "영구적인 승자 대신 반복 가능한 실제 비교",
  reviewedLabel: "검토일",
  reviewedDate: "2026년 7월 14일",
  modelsLabel: "Tomverse 표시 모델",
  scopeNote:
    "현재 Tomverse에 구성된 접근 가능한 비교 조합인 GPT-5.4 mini와 Claude Haiku 4.5를 기준으로 합니다. 공급자 업데이트, 프롬프트, 샘플링, 도구와 맥락에 따라 개별 결과는 달라질 수 있습니다.",
  resultsTitle: "업무별 ChatGPT vs Claude 비교",
  resultsBody:
    "아래 내용은 공정한 테스트를 설계하기 위한 정성적 편집 가이드입니다. 공급자 벤치마크 점수나 모든 응답이 동일하게 동작한다는 보장이 아닙니다.",
  taskHeader: "업무",
  gptHeader: "GPT에서 확인할 점",
  claudeHeader: "Claude에서 확인할 점",
  decisionHeader: "선택 기준",
  tasks: [
    { task: "글쓰기", gpt: "간결한 구조, 형식 제어와 수정 지시 반영 속도를 확인합니다.", claude: "긴 글에서 문체, 자연스러운 전환과 전체 일관성을 확인합니다.", decision: "실제 브랜드 문체 샘플로 수정해야 할 분량을 비교합니다." },
    { task: "코딩", gpt: "범위가 명확한 패치, 대안 구현과 테스트 계획을 확인합니다.", claude: "장단점 설명과 더 넓은 코드 맥락을 검토에 반영했는지 확인합니다.", decision: "설명보다 코드 실행과 테스트 통과 여부를 우선합니다." },
    { task: "긴 문서", gpt: "구체적인 질문과 출력 형식이 누락을 줄이는지 확인합니다.", claude: "여러 섹션의 맥락과 중요한 단서가 요약 후에도 유지되는지 확인합니다.", decision: "출처, 숫자, 누락과 실제 컨텍스트 한도를 검증합니다." },
    { task: "요약", gpt: "빠르게 훑을 수 있는 구조와 요청한 압축 수준을 확인합니다.", claude: "뉘앙스, 연결 맥락과 주의사항이 유지되는지 확인합니다.", decision: "짧은 실행 항목과 맥락 보존 중 무엇이 중요한지 선택합니다." },
    { task: "지시사항 준수", gpt: "명확한 형식과 제약 체크리스트로 각 요구사항을 점검합니다.", claude: "상세한 자연어 제약을 적용한 뒤 최종 답변의 일관성을 확인합니다.", decision: "테스트 전에 합격 기준을 정하고 두 번 이상 반복합니다." },
  ],
  resultTitle: "비교 결과 예시",
  resultBody: "유용한 결과는 단순히 ‘어느 답변이 더 좋아 보이는가’가 아닙니다. 각 답변이 보존한 것, 빠뜨린 것과 검증하기 쉬운 부분을 기록해야 합니다.",
  samplePromptLabel: "동일 프롬프트",
  samplePrompt: "120단어 고객 업데이트를 60단어 경영진 브리프로 다시 작성하세요. 모든 날짜와 위험을 유지하고 정확히 3개 불릿과 권장 조치 1개를 반환하세요.",
  gptResult: "구조화된 결과는 불릿 수, 날짜와 권장 조치를 점검하기 쉬웠습니다. 강한 압축 과정에서 유용한 맥락이 빠졌는지가 주요 검토 대상입니다.",
  claudeResult: "설명 맥락과 자연스러운 경영진 문체가 유지되었습니다. 정확한 분량과 모든 형식 제약을 지켰는지가 주요 검토 대상입니다.",
  resultTakeaway: "결론: 두 모델 모두 작업을 수행할 수 있으며, 미리 작성한 합격 기준을 더 적은 수정으로 통과한 결과가 해당 작업에 더 적합합니다.",
  resultDisclaimer: "실시간 모델 응답의 원문이 아니라 축약된 편집 검토 예시입니다. 아래 사전 선택 CTA를 사용하면 동일 프롬프트로 현재 결과를 만들 수 있습니다.",
  methodTitle: "비교 방법론",
  methodBody: "공정한 비교는 입력 조건을 통제하고 다른 사람이 반복할 수 있을 만큼 맥락을 기록합니다.",
  methodSteps: [
    "두 모델에 동일한 프롬프트, 첨부파일, 언어와 출력 제약을 전송합니다.",
    "답변을 보기 전에 사실 정확성, 완전성, 형식, 문체와 검증 기준을 정합니다.",
    "전체 답변을 검토하고 중요한 주장은 독립적으로 확인하며 실행 가능한 코드와 테스트를 직접 실행합니다.",
    "정확한 모델명과 검토일을 기록하고, 응답의 비결정성을 고려해 대표 작업을 반복합니다.",
  ],
  screenTitle: "Tomverse 비교 화면 구성",
  screenBody: "같은 프롬프트 옆에 두 답변이 유지되어 구조, 누락과 후속 답변의 차이를 더 쉽게 확인할 수 있습니다.",
  screenPrompt: "출시 위험을 정확히 3개 불릿으로 요약하고 다음 조치 1개를 권장하세요.",
  screenCaption: "현재 Tomverse 나란히 비교 인터페이스를 재현한 화면입니다. 가독성을 위해 응답 문구를 축약했으며 모델 가용성은 상태 페이지에서 별도로 제공합니다.",
  promptsTitle: "복사해서 비교할 프롬프트",
  promptsBody: "대괄호 안의 맥락을 실제 자료로 바꾸고 두 모델에 동일한 합격 기준을 사용하세요.",
  promptExamples: [
    { label: "글쓰기", prompt: "[초안]을 [대상 독자]에게 맞춰 120단어로 다시 작성하세요. 모든 사실을 유지하고 과장을 제거한 뒤 명확한 CTA 1개로 끝내세요." },
    { label: "코딩", prompt: "[코드]의 정확성, 보안과 유지보수성을 검토하세요. 심각도별 문제, 최소 패치, 수정 전 실패해야 하는 테스트를 반환하세요." },
    { label: "긴 문서", prompt: "[문서]만 사용해 결정 5개와 담당자, 날짜, 미해결 위험을 정리하고 각 항목의 근거가 되는 섹션 제목을 표시하세요." },
    { label: "지시사항 준수", prompt: "정확히 4개 불릿으로 답하세요. 각 불릿은 18단어 미만이고 동사 1개를 포함하며 도입 문장은 없어야 합니다." },
  ],
  fitTitle: "어떤 사용자에게 어떤 모델이 적합한가",
  fitCards: [
    { title: "GPT부터 시작할 경우", body: "간결한 구조, 반복 수정, 명확한 출력 형식 또는 구현 중심 기술 작업이 중요한 워크플로입니다." },
    { title: "Claude부터 시작할 경우", body: "지속적인 문체, 맥락 설명, 긴 글의 흐름 또는 큰 브리프의 세심한 검토가 중요한 워크플로입니다." },
    { title: "두 모델을 비교할 경우", body: "결과의 영향이 크거나 주관적이고 낯선 작업으로서 독립적인 두 번째 접근법의 가치가 큰 경우입니다." },
  ],
  faqTitle: "ChatGPT vs Claude FAQ",
  faqs: [
    { question: "ChatGPT가 Claude보다 좋은가요?", answer: "모든 작업에 적용되는 승자는 없습니다. 실제 프롬프트와 사전에 정한 합격 기준으로 현재 사용할 수 있는 정확한 모델을 비교해야 합니다." },
    { question: "코딩에는 어느 모델이 더 좋은가요?", answer: "두 모델 모두 코딩을 지원할 수 있습니다. 설명의 자신감보다 코드 실행, 테스트 통과, 보안 문제 해결과 저장소 적합성을 평가하세요." },
    { question: "긴 문서에는 어느 모델이 더 좋은가요?", answer: "문서 크기, 추출 가능 여부, 모델 컨텍스트 한도와 질문에 따라 다릅니다. 출처, 숫자, 제외 내용과 결론을 원본 문서와 대조하세요." },
    { question: "같은 프롬프트면 완전히 공정한 비교인가요?", answer: "비교 가능성은 높아지지만 공급자 시스템 지시, 도구, 맥락 처리와 모델 업데이트가 다를 수 있습니다. 이 한계를 검토 기록에 남기세요." },
    { question: "Tomverse는 OpenAI 또는 Anthropic과 제휴했나요?", answer: "아닙니다. Tomverse는 독립적인 멀티모델 워크스페이스이며 OpenAI 또는 Anthropic과 제휴하거나 보증받지 않았습니다." },
  ],
  relatedTitle: "관련 비교 콘텐츠",
  relatedLinks: [
    { label: "AI 모델 비교", href: "/compare-ai-models", body: "더 많은 공급자를 반복 가능한 방식으로 비교하세요." },
    { label: "AI 파일 분석", href: "/ai-for-file-analysis", body: "PDF, Office 파일과 이미지를 이용해 모델을 비교하세요." },
    { label: "사용 가능 모델", href: "/models", body: "Usage class, 기본 크레딧 차감량과 가용성을 확인하세요." },
  ],
  ctaEyebrow: "같은 조건으로 직접 테스트",
  ctaTitle: "GPT-5.4 mini와 Claude Haiku 4.5를 나란히 비교하세요",
  ctaBody: "모델과 예시 프롬프트가 미리 선택됩니다. 멀티모델 비교, 파일, 저장과 공유에는 로그인이 필요합니다.",
  ctaLabel: "같은 프롬프트로 비교하기",
  signInNote: "먼저 로그인한 뒤 준비된 비교 화면으로 돌아옵니다.",
  independentNotice: "Tomverse는 독립 서비스입니다. ChatGPT, GPT, Claude, OpenAI, Anthropic 명칭과 상표는 각 소유자에게 귀속됩니다.",
};

const guideCopy: Partial<Record<Language, GuideCopy>> = {
  en: englishGuide,
  ko: koreanGuide,
};

const comparisonModelIds = ["gpt-5-4-mini", "claude-haiku-4-5"];

export function ChatGptVsClaudeGuide() {
  const { lang } = useLanguage();
  const { status } = useSession();
  const copy = guideCopy[lang] ?? englishGuide;
  const comparisonParams = new URLSearchParams({
    lang,
    models: comparisonModelIds.join(","),
    prompt: copy.samplePrompt,
    source: "chatgpt-vs-claude",
  });
  const comparisonPath = `/chat?${comparisonParams.toString()}`;
  const comparisonHref =
    status === "authenticated"
      ? comparisonPath
      : `/auth/signin?callbackUrl=${encodeURIComponent(comparisonPath)}`;

  return (
    <div className="mt-10 space-y-16 lg:mt-14 lg:space-y-20">
      <nav aria-label={copy.jumpLabel} className="flex flex-wrap items-center gap-2 rounded-2xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
        <span className="px-2 text-xs font-black uppercase tracking-[0.15em] text-zinc-500">{copy.jumpLabel}</span>
        {copy.jumpLinks.map((item) => (
          <a key={item.href} href={item.href} className="rounded-full bg-white px-3 py-1.5 text-xs font-bold text-zinc-700 ring-1 ring-zinc-200 transition hover:text-blue-600 dark:bg-zinc-950 dark:text-zinc-200 dark:ring-zinc-800 dark:hover:text-blue-400">
            {item.label}
          </a>
        ))}
      </nav>

      <section className="overflow-hidden rounded-3xl border border-blue-200 bg-gradient-to-br from-blue-50 via-white to-orange-50 p-5 dark:border-blue-900/60 dark:from-blue-950/35 dark:via-zinc-950 dark:to-orange-950/20 sm:p-7">
        <p className="text-xs font-black uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">{copy.scopeEyebrow}</p>
        <h2 className="mt-3 max-w-3xl text-2xl font-black sm:text-3xl">{copy.scopeTitle}</h2>
        <div className="mt-6 grid gap-3 md:grid-cols-2">
          <div className="rounded-2xl border border-zinc-200 bg-white/90 p-4 dark:border-zinc-800 dark:bg-zinc-950/80">
            <p className="text-xs font-black uppercase tracking-wider text-zinc-500">{copy.modelsLabel}</p>
            <div className="mt-3 flex flex-wrap gap-3">
              <ModelBadge image="/model-icons/chatgpt.png" name="GPT-5.4 mini" provider="OpenAI" />
              <ModelBadge image="/model-icons/claude.png" name="Claude Haiku 4.5" provider="Anthropic" />
            </div>
          </div>
          <div className="rounded-2xl border border-zinc-200 bg-white/90 p-4 dark:border-zinc-800 dark:bg-zinc-950/80">
            <p className="text-xs font-black uppercase tracking-wider text-zinc-500">{copy.reviewedLabel}</p>
            <p className="mt-3 text-lg font-black">{copy.reviewedDate}</p>
            <p className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{copy.scopeNote}</p>
          </div>
        </div>
      </section>

      <section id="task-comparison" className="scroll-mt-24">
        <SectionHeading icon={Scale} title={copy.resultsTitle} body={copy.resultsBody} />
        <div className="mt-7 overflow-x-auto rounded-2xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full min-w-[900px] border-collapse text-left text-sm">
            <thead className="bg-zinc-950 text-white">
              <tr>
                {[copy.taskHeader, copy.gptHeader, copy.claudeHeader, copy.decisionHeader].map((header) => (
                  <th key={header} scope="col" className="px-4 py-3 text-xs font-black uppercase tracking-wider">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {copy.tasks.map((row) => (
                <tr key={row.task} className="border-t border-zinc-200 align-top dark:border-zinc-800">
                  <th scope="row" className="w-32 bg-zinc-50 px-4 py-4 font-black dark:bg-zinc-900/60">{row.task}</th>
                  <td className="px-4 py-4 leading-6 text-zinc-600 dark:text-zinc-300">{row.gpt}</td>
                  <td className="px-4 py-4 leading-6 text-zinc-600 dark:text-zinc-300">{row.claude}</td>
                  <td className="px-4 py-4 font-semibold leading-6 text-zinc-800 dark:text-zinc-100">{row.decision}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-3xl bg-zinc-950 p-5 text-white sm:p-8">
        <h2 className="text-2xl font-black sm:text-3xl">{copy.resultTitle}</h2>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-zinc-300">{copy.resultBody}</p>
        <div className="mt-6 rounded-2xl border border-zinc-700 bg-zinc-900 p-4">
          <p className="text-xs font-black uppercase tracking-wider text-blue-300">{copy.samplePromptLabel}</p>
          <p className="mt-2 text-sm font-semibold leading-6 text-white">{copy.samplePrompt}</p>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <ResultCard image="/model-icons/chatgpt.png" title="GPT-5.4 mini" body={copy.gptResult} accent="blue" />
          <ResultCard image="/model-icons/claude.png" title="Claude Haiku 4.5" body={copy.claudeResult} accent="orange" />
        </div>
        <p className="mt-5 rounded-xl bg-emerald-500/10 px-4 py-3 text-sm font-bold leading-6 text-emerald-100">{copy.resultTakeaway}</p>
        <p className="mt-3 text-xs leading-5 text-zinc-400">{copy.resultDisclaimer}</p>
      </section>

      <section id="methodology" className="scroll-mt-24">
        <SectionHeading icon={CheckCircle2} title={copy.methodTitle} body={copy.methodBody} />
        <ol className="mt-7 grid gap-4 sm:grid-cols-2">
          {copy.methodSteps.map((step, index) => (
            <li key={step} className="flex gap-4 rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-black text-white">{index + 1}</span>
              <span className="text-sm font-semibold leading-6 text-zinc-700 dark:text-zinc-200">{step}</span>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <SectionHeading icon={Sparkles} title={copy.screenTitle} body={copy.screenBody} />
        <figure className="mt-7 overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 p-3 shadow-2xl shadow-blue-950/20 sm:p-5">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-3 text-sm font-semibold text-zinc-100 sm:p-4">{copy.screenPrompt}</div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <PreviewPanel image="/model-icons/chatgpt.png" model="GPT-5.4 mini" body={copy.gptResult} />
            <PreviewPanel image="/model-icons/claude.png" model="Claude Haiku 4.5" body={copy.claudeResult} />
          </div>
          <figcaption className="px-2 pb-1 pt-4 text-xs leading-5 text-zinc-400">{copy.screenCaption}</figcaption>
        </figure>
      </section>

      <section id="prompt-examples" className="scroll-mt-24">
        <SectionHeading icon={Code2} title={copy.promptsTitle} body={copy.promptsBody} />
        <div className="mt-7 grid gap-4 md:grid-cols-2">
          {copy.promptExamples.map((example) => (
            <article key={example.label} className="rounded-2xl border border-zinc-200 bg-zinc-50 p-5 dark:border-zinc-800 dark:bg-zinc-900/40">
              <p className="text-xs font-black uppercase tracking-wider text-blue-600 dark:text-blue-400">{example.label}</p>
              <p className="mt-3 font-mono text-sm leading-6 text-zinc-700 dark:text-zinc-200">{example.prompt}</p>
            </article>
          ))}
        </div>
      </section>

      <section>
        <SectionHeading icon={PenLine} title={copy.fitTitle} />
        <div className="mt-7 grid gap-4 md:grid-cols-3">
          {copy.fitCards.map((card) => (
            <article key={card.title} className="rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800">
              <h3 className="font-black">{card.title}</h3>
              <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{card.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="comparison-faq" className="scroll-mt-24">
        <SectionHeading icon={FileText} title={copy.faqTitle} />
        <div className="mt-7 divide-y divide-zinc-200 overflow-hidden rounded-2xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {copy.faqs.map((faq) => (
            <details key={faq.question} className="group bg-white px-5 py-4 open:bg-zinc-50 dark:bg-zinc-950 dark:open:bg-zinc-900/50">
              <summary className="cursor-pointer list-none pr-8 font-black marker:hidden">{faq.question}</summary>
              <p className="mt-3 max-w-4xl text-sm leading-7 text-zinc-600 dark:text-zinc-300">{faq.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-black">{copy.relatedTitle}</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          {copy.relatedLinks.map((item) => (
            <Link key={item.href} href={item.href} className="group rounded-2xl border border-zinc-200 p-5 transition hover:border-blue-400 hover:bg-blue-50/50 dark:border-zinc-800 dark:hover:border-blue-700 dark:hover:bg-blue-950/20">
              <span className="flex items-center justify-between gap-3 font-black group-hover:text-blue-600 dark:group-hover:text-blue-400">
                {item.label}
                <ArrowRight className="h-4 w-4" />
              </span>
              <span className="mt-2 block text-sm leading-6 text-zinc-500 dark:text-zinc-400">{item.body}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="rounded-3xl bg-blue-600 p-6 text-white sm:p-9">
        <p className="text-xs font-black uppercase tracking-[0.2em] text-blue-100">{copy.ctaEyebrow}</p>
        <h2 className="mt-3 max-w-3xl text-3xl font-black sm:text-4xl">{copy.ctaTitle}</h2>
        <p className="mt-4 max-w-3xl text-sm leading-7 text-blue-50">{copy.ctaBody}</p>
        <Link
          href={comparisonHref}
          onClick={() => trackProductEvent("cta_start_click", 2, { cta_location: "chatgpt_vs_claude_guide" })}
          className="mt-6 inline-flex min-h-12 items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-black text-blue-700 transition hover:bg-blue-50"
        >
          {copy.ctaLabel}
          <ArrowRight className="h-4 w-4" />
        </Link>
        {status !== "authenticated" && <p className="mt-3 text-xs font-semibold text-blue-100">{copy.signInNote}</p>}
      </section>

      <p className="border-t border-zinc-200 pt-6 text-xs leading-5 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">{copy.independentNotice}</p>
    </div>
  );
}

function SectionHeading({ icon: Icon, title, body }: { icon: typeof Scale; title: string; body?: string }) {
  return (
    <div className="max-w-3xl">
      <Icon className="h-6 w-6 text-blue-600 dark:text-blue-400" />
      <h2 className="mt-4 text-3xl font-black sm:text-4xl">{title}</h2>
      {body && <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">{body}</p>}
    </div>
  );
}

function ModelBadge({ image, name, provider }: { image: string; name: string; provider: string }) {
  return (
    <span className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
      <Image unoptimized src={image} width={32} height={32} alt="" className="h-8 w-8 rounded-lg object-contain" />
      <span><span className="block text-sm font-black">{name}</span><span className="block text-[11px] text-zinc-500">{provider}</span></span>
    </span>
  );
}

function ResultCard({ image, title, body, accent }: { image: string; title: string; body: string; accent: "blue" | "orange" }) {
  return (
    <article className={`rounded-2xl border p-4 ${accent === "blue" ? "border-blue-400/30 bg-blue-500/10" : "border-orange-400/30 bg-orange-500/10"}`}>
      <div className="flex items-center gap-3"><Image unoptimized src={image} width={36} height={36} alt="" className="h-9 w-9 rounded-lg bg-white object-contain" /><h3 className="font-black">{title}</h3></div>
      <p className="mt-4 text-sm leading-7 text-zinc-300">{body}</p>
    </article>
  );
}

function PreviewPanel({ image, model, body }: { image: string; model: string; body: string }) {
  return (
    <article className="min-h-56 rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex items-center gap-3 border-b border-zinc-800 pb-3"><Image unoptimized src={image} width={34} height={34} alt="" className="h-[34px] w-[34px] rounded-lg bg-white object-contain" /><div><h3 className="text-sm font-black text-white">{model}</h3><p className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">Available</p></div></div>
      <p className="mt-4 text-sm leading-7 text-zinc-300">{body}</p>
    </article>
  );
}
