"use client";

import Link from "next/link";
import {
  ArrowRight,
  Bot,
  BriefcaseBusiness,
  CheckCircle2,
  Code2,
  FileText,
  HelpCircle,
  Layers3,
  LockKeyhole,
  Search,
  Share2,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";

const supportedModels = [
  { name: "GPT", mark: "◎", detail: "OpenAI", className: "from-white to-zinc-100", image: "/model-icons/chatgpt.png" },
  { name: "Claude", mark: "AI", detail: "Anthropic", className: "from-white to-orange-50", image: "/model-icons/claude.png" },
  { name: "Gemini", mark: "✦", detail: "Google", className: "from-white to-sky-50", image: "/model-icons/gemini.png" },
  { name: "Llama", mark: "∞", detail: "Groq", className: "from-white to-blue-50", image: "/model-icons/llama.png" },
  { name: "DeepSeek", mark: "DS", detail: "DeepSeek", className: "from-white to-blue-50", image: "/model-icons/deepseek.png" },
  { name: "Grok", mark: "/", detail: "xAI", className: "from-white to-zinc-100", image: "/model-icons/grok.png" },
  { name: "Kimi", mark: "KM", detail: "Moonshot", className: "from-purple-500 to-fuchsia-500" },
  { name: "Qwen", mark: "QW", detail: "Alibaba", className: "from-white to-indigo-50", image: "/model-icons/qwen.png" },
  { name: "Perplexity", mark: "P", detail: "Sonar", className: "from-white to-cyan-50", image: "/model-icons/perplexity.png" },
  { name: "Mistral", mark: "M", detail: "Coming soon", className: "from-amber-400 to-red-500" },
];

type CardCopy = { title: string; description: string };
type PricingPreviewCopy = CardCopy & { price: string; bullets: string[] };

type LandingCopy = {
  app: string;
  badge: string;
  title: string;
  description: string;
  primaryCta: string;
  pricingCta: string;
  steps: string[];
  previewTitle: string;
  previewCount: string;
  previewAnswers: string[];
  featuresTitle: string;
  featuresDescription: string;
  features: CardCopy[];
  useCasesTitle: string;
  useCasesDescription: string;
  useCases: CardCopy[];
  whyTitle: string;
  whyDescription: string;
  whyItems: CardCopy[];
  trustTitle: string;
  trustDescription: string;
  trustItems: CardCopy[];
  modelsTitle: string;
  modelsDescription: string;
  pricingTitle: string;
  pricingDescription: string;
  pricingPlans: PricingPreviewCopy[];
  faqTitle: string;
  faqs: Array<{ question: string; answer: string }>;
  ctaTitle: string;
  ctaDescription: string;
};

const copy = {
  en: {
    app: "Open app",
    badge: "Multi-model AI workspace",
    title: "Compare the best AI answers in one place.",
    description:
      "Tomverse AI helps you ask once, compare multiple models, attach real files, and keep useful conversations organized for work that needs sharper answers.",
    primaryCta: "Start for free",
    pricingCta: "View pricing",
    steps: ["Choose up to three models", "Send one prompt or attach files", "Compare, follow up, share, or export"],
    previewTitle: "Tomverse comparison",
    previewCount: "3 models",
    previewAnswers: [
      "Direct answer with practical next steps.",
      "Careful reasoning and tradeoffs.",
      "Fast summary with concise structure.",
    ],
    featuresTitle: "A calmer way to use many AIs.",
    featuresDescription:
      "Designed for repeated work, not one-off demos. Keep your model choices, files, private sessions, and shareable outputs in one workflow.",
    features: [
      { title: "Compare AI models side by side", description: "Ask once and compare answers from multiple leading models in one focused workspace." },
      { title: "Work with files and context", description: "Attach images, PDFs, office documents, and Google Drive files when your task needs real material." },
      { title: "Share polished conversations", description: "Turn useful chats into read-only public pages or download them as clean text records." },
      { title: "Built for privacy-aware work", description: "Use locked chats, Private Mode, rate limits, and hardened security controls for safer daily use." },
    ],
    useCasesTitle: "Built for real daily work.",
    useCasesDescription: "Use Tomverse when the task benefits from multiple perspectives, real files, and a reusable record.",
    useCases: [
      { title: "Research and summaries", description: "Compare concise summaries, deeper analysis, and source-aware follow-up ideas." },
      { title: "Coding and debugging", description: "Ask several models for fixes, tradeoffs, tests, and alternative implementations." },
      { title: "Business writing", description: "Draft emails, proposals, product copy, and planning notes with multiple styles." },
      { title: "File-based analysis", description: "Bring screenshots, PDFs, office files, and Drive context into the conversation." },
    ],
    whyTitle: "Why use Tomverse instead of opening every AI app?",
    whyDescription: "Tomverse keeps model choice, conversation context, sharing, and privacy controls in one workflow.",
    whyItems: [
      { title: "One prompt, multiple answers", description: "Compare different model strengths without copying prompts across tabs." },
      { title: "Follow up where it matters", description: "Ask a specific model a follow-up while keeping the full comparison nearby." },
      { title: "Portable outcomes", description: "Share useful conversations or download clean text records for later work." },
    ],
    trustTitle: "Designed with trust controls from day one.",
    trustDescription: "Public AI tools need clear boundaries. Tomverse makes privacy and sharing behavior visible to users.",
    trustItems: [
      { title: "Private Mode clarity", description: "Private Mode does not save Tomverse chat history, while still sending prompts to selected AI providers." },
      { title: "Read-only share snapshots", description: "Shared links are public read-only views designed to avoid exposing later conversation updates." },
      { title: "Locked conversations", description: "Sensitive chats can be locked and require unlock verification before protected actions." },
      { title: "Attachment safeguards", description: "Files are validated, bounded, and handled with temporary storage controls." },
    ],
    modelsTitle: "Built around the model market.",
    modelsDescription:
      "New models arrive constantly. Tomverse keeps model choice centralized so users can compare the right options without rebuilding their workflow.",
    pricingTitle: "Start free, upgrade when usage grows.",
    pricingDescription: "Plans are built around usage allowance, file workflows, sharing, and access to the available model catalogue.",
    pricingPlans: [
      { title: "Free", price: "$0", description: "For trying Tomverse and light daily work.", bullets: ["Selected free models", "Basic daily usage", "Good for personal testing"] },
      { title: "Pro", price: "Coming soon", description: "For everyday multi-model comparison.", bullets: ["All available models", "Higher usage limits", "Files, sharing, downloads"] },
      { title: "Max", price: "Coming soon", description: "For heavier AI workflows.", bullets: ["Largest allowance", "Higher file limits", "Priority room for advanced models"] },
    ],
    faqTitle: "Quick questions",
    faqs: [
      { question: "Can I use Tomverse for free?", answer: "Yes. Free is intended for light usage and selected model access." },
      { question: "Which models are supported?", answer: "Tomverse supports models across providers such as OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Moonshot, Qwen, and Perplexity." },
      { question: "What is Private Mode?", answer: "Private Mode means Tomverse does not save the conversation to the Tomverse database. AI providers may still receive prompts to generate responses." },
      { question: "Can I attach files?", answer: "Yes. Tomverse supports images, PDFs, Office documents, Google Drive files, and other allowed attachment types depending on provider support." },
    ],
    ctaTitle: "Ready to compare smarter?",
    ctaDescription: "Start with the free workspace and upgrade when you need more power.",
  },
  ko: {
    app: "앱 열기",
    badge: "멀티 모델 AI 워크스페이스",
    title: "최고의 AI 답변을 한곳에서 비교하세요.",
    description:
      "Tomverse AI는 한 번의 질문으로 여러 모델의 답변을 비교하고, 실제 파일을 첨부하며, 업무에 필요한 대화를 정리할 수 있게 도와줍니다.",
    primaryCta: "무료로 시작하기",
    pricingCta: "요금 보기",
    steps: ["최대 3개 모델 선택", "질문 또는 파일 첨부", "비교, 추가 질문, 공유, 내보내기"],
    previewTitle: "Tomverse 비교",
    previewCount: "3개 모델",
    previewAnswers: ["실행 가능한 다음 단계 중심 답변", "근거와 선택지를 함께 검토", "빠르고 간결한 구조화 요약"],
    featuresTitle: "여러 AI를 더 차분하게 사용하는 방법.",
    featuresDescription:
      "일회성 데모가 아니라 반복 업무를 위해 설계했습니다. 모델 선택, 파일, Private Mode, 공유 결과물을 하나의 흐름으로 관리하세요.",
    features: [
      { title: "AI 모델을 나란히 비교", description: "한 번 질문하고 여러 최신 모델의 답변을 한 화면에서 집중해서 비교할 수 있습니다." },
      { title: "파일과 맥락까지 함께 작업", description: "이미지, PDF, 오피스 문서, Google Drive 파일을 첨부해 실제 자료 기반으로 질문할 수 있습니다." },
      { title: "대화를 깔끔하게 공유", description: "유용한 대화를 읽기 전용 공개 페이지로 만들거나 정리된 텍스트 파일로 다운로드할 수 있습니다." },
      { title: "프라이버시를 고려한 업무 환경", description: "잠금 대화, Private Mode, 사용량 제한, 보안 헤더 등 안전한 일상 사용을 위한 기본기를 갖췄습니다." },
    ],
    useCasesTitle: "실제 일상 업무를 위해 설계했습니다.",
    useCasesDescription: "여러 관점, 실제 파일, 재사용 가능한 기록이 필요한 작업에서 Tomverse가 빛납니다.",
    useCases: [
      { title: "리서치와 요약", description: "간결한 요약, 깊은 분석, 후속 질문 아이디어를 여러 모델 관점에서 비교하세요." },
      { title: "코딩과 디버깅", description: "수정안, 트레이드오프, 테스트, 대안 구현을 여러 모델에게 물어볼 수 있습니다." },
      { title: "비즈니스 글쓰기", description: "이메일, 제안서, 제품 문구, 기획 노트를 다양한 톤으로 만들어보세요." },
      { title: "파일 기반 분석", description: "스크린샷, PDF, 오피스 파일, Drive 자료를 대화 맥락에 포함할 수 있습니다." },
    ],
    whyTitle: "왜 여러 AI 앱을 따로 열지 않고 Tomverse를 사용할까요?",
    whyDescription: "Tomverse는 모델 선택, 대화 맥락, 공유, 프라이버시 제어를 하나의 흐름으로 묶습니다.",
    whyItems: [
      { title: "한 번 질문하고 여러 답변 비교", description: "여러 탭에 질문을 복사하지 않고 모델별 강점을 바로 비교합니다." },
      { title: "필요한 모델에만 추가 질문", description: "전체 비교 흐름은 유지하면서 특정 모델에만 후속 질문을 보낼 수 있습니다." },
      { title: "결과물을 이동 가능하게", description: "유용한 대화는 공유하거나 텍스트 기록으로 내려받아 다시 활용할 수 있습니다." },
    ],
    trustTitle: "처음부터 신뢰 제어를 포함해 설계했습니다.",
    trustDescription: "공개 AI 도구에는 명확한 경계가 필요합니다. Tomverse는 저장, 공유, 잠금 동작을 사용자에게 분명히 보여줍니다.",
    trustItems: [
      { title: "Private Mode 안내", description: "Private Mode는 Tomverse 대화 기록을 저장하지 않지만, 선택한 AI 공급자에게 질문은 전송될 수 있습니다." },
      { title: "읽기 전용 공유 스냅샷", description: "공유 링크는 공개 읽기 전용 화면이며, 이후 대화가 의도치 않게 노출되지 않도록 설계했습니다." },
      { title: "잠금 대화", description: "민감한 대화는 잠글 수 있고, 보호된 작업 전 잠금 해제 검증이 필요합니다." },
      { title: "첨부파일 보호", description: "파일은 검증, 크기 제한, 임시 저장 제어를 거쳐 처리됩니다." },
    ],
    modelsTitle: "빠르게 변하는 모델 시장을 기준으로 설계.",
    modelsDescription:
      "새 모델은 계속 등장합니다. Tomverse는 모델 선택을 중앙에서 관리해 사용자가 워크플로를 바꾸지 않고 적절한 모델을 비교할 수 있게 합니다.",
    pricingTitle: "무료로 시작하고 사용량이 늘면 업그레이드하세요.",
    pricingDescription: "요금제는 사용량 한도, 파일 워크플로, 공유 기능, 사용 가능한 모델 카탈로그 접근을 기준으로 설계했습니다.",
    pricingPlans: [
      { title: "Free", price: "$0", description: "Tomverse 체험과 가벼운 일상 작업용입니다.", bullets: ["선택된 무료 모델", "기본 일일 사용량", "개인 테스트에 적합"] },
      { title: "Pro", price: "준비 중", description: "일상적인 멀티 모델 비교용입니다.", bullets: ["사용 가능한 전체 모델", "더 높은 사용량 한도", "파일, 공유, 다운로드"] },
      { title: "Max", price: "준비 중", description: "고강도 AI 워크플로용입니다.", bullets: ["가장 큰 사용량 한도", "더 높은 파일 한도", "고급 모델을 위한 우선 여유"] },
    ],
    faqTitle: "빠른 질문",
    faqs: [
      { question: "무료로 사용할 수 있나요?", answer: "네. Free는 가벼운 사용량과 선택된 모델 접근을 위해 제공됩니다." },
      { question: "어떤 모델을 지원하나요?", answer: "OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Moonshot, Qwen, Perplexity 등 여러 공급자의 모델을 지원합니다." },
      { question: "Private Mode는 무엇인가요?", answer: "Tomverse 데이터베이스에 대화를 저장하지 않는 모드입니다. 답변 생성을 위해 AI 공급자에게 질문은 전송될 수 있습니다." },
      { question: "파일 첨부가 가능한가요?", answer: "네. 이미지, PDF, Office 문서, Google Drive 파일 등 허용된 첨부 형식을 지원합니다. 공급자별 지원 범위는 다를 수 있습니다." },
    ],
    ctaTitle: "더 똑똑하게 비교해볼까요?",
    ctaDescription: "무료 워크스페이스로 시작하고 더 강력한 기능이 필요할 때 업그레이드하세요.",
  },
  zh: {
    app: "打开应用",
    badge: "多模型 AI 工作区",
    title: "在一个地方比较顶级 AI 的回答。",
    description:
      "Tomverse AI 让你一次提问，同时比较多个模型，附加真实文件，并把有价值的对话整理成清晰的工作流程。",
    primaryCta: "免费开始",
    pricingCta: "查看价格",
    steps: ["最多选择三个模型", "发送提示或附加文件", "比较、追问、分享或导出"],
    previewTitle: "Tomverse 对比",
    previewCount: "3 个模型",
    previewAnswers: ["直接回答并给出可执行步骤", "更谨慎的推理与取舍", "快速、简洁、结构化总结"],
    featuresTitle: "更从容地使用多个 AI。",
    featuresDescription:
      "为日常重复工作而设计，而不只是一次性演示。模型选择、文件、私密会话和分享输出都在一个流程中。",
    features: [
      { title: "并排比较 AI 模型", description: "一次提问，在同一个专注工作区比较多个领先模型的回答。" },
      { title: "结合文件和上下文工作", description: "当任务需要真实资料时，可附加图片、PDF、办公文档和 Google Drive 文件。" },
      { title: "分享精美的对话", description: "把有用的聊天转成只读公开页面，或下载为整洁的文本记录。" },
      { title: "为注重隐私的工作而构建", description: "通过锁定聊天、Private Mode、速率限制和安全控制，让日常使用更安心。" },
    ],
    useCasesTitle: "为真实日常工作而构建。",
    useCasesDescription: "当任务需要多个视角、真实文件和可复用记录时，Tomverse 会更有价值。",
    useCases: [
      { title: "研究和总结", description: "比较简洁总结、深入分析和后续问题思路。" },
      { title: "编码和调试", description: "向多个模型询问修复方案、取舍、测试和替代实现。" },
      { title: "商务写作", description: "用多种风格起草邮件、提案、产品文案和计划笔记。" },
      { title: "基于文件的分析", description: "把截图、PDF、办公文件和 Drive 上下文带入对话。" },
    ],
    whyTitle: "为什么不用分别打开每个 AI 应用？",
    whyDescription: "Tomverse 将模型选择、对话上下文、分享和隐私控制放在一个流程中。",
    whyItems: [
      { title: "一次提问，多种回答", description: "无需在多个标签页复制提示，也能比较不同模型的强项。" },
      { title: "只向需要的模型追问", description: "保留整体比较，同时只对某个模型发送后续问题。" },
      { title: "结果可带走", description: "有用的对话可以分享，或下载为清晰的文本记录。" },
    ],
    trustTitle: "从第一天起就包含信任控制。",
    trustDescription: "公开 AI 工具需要清楚的边界。Tomverse 会明确呈现保存、分享和锁定行为。",
    trustItems: [
      { title: "Private Mode 说明", description: "Private Mode 不保存 Tomverse 聊天历史，但提示仍可能发送给所选 AI 供应商。" },
      { title: "只读分享快照", description: "分享链接是公开只读视图，设计上避免后续对话被意外暴露。" },
      { title: "锁定对话", description: "敏感对话可以锁定，受保护操作前需要完成解锁验证。" },
      { title: "附件保护", description: "文件会经过验证、大小限制和临时存储控制。" },
    ],
    modelsTitle: "围绕快速变化的模型市场构建。",
    modelsDescription:
      "新模型不断出现。Tomverse 将模型选择集中管理，让用户不用重建流程也能比较合适的选项。",
    pricingTitle: "免费开始，用量增长后再升级。",
    pricingDescription: "方案围绕使用额度、文件工作流、分享功能和可用模型目录访问来设计。",
    pricingPlans: [
      { title: "Free", price: "$0", description: "适合体验 Tomverse 和轻量日常工作。", bullets: ["部分免费模型", "基础每日额度", "适合个人测试"] },
      { title: "Pro", price: "即将推出", description: "适合日常多模型比较。", bullets: ["全部可用模型", "更高使用额度", "文件、分享、下载"] },
      { title: "Max", price: "即将推出", description: "适合高强度 AI 工作流。", bullets: ["最大使用额度", "更高文件限制", "高级模型优先空间"] },
    ],
    faqTitle: "快速问题",
    faqs: [
      { question: "可以免费使用吗？", answer: "可以。Free 面向轻量使用和部分模型访问。" },
      { question: "支持哪些模型？", answer: "Tomverse 支持 OpenAI、Anthropic、Google、Groq、DeepSeek、xAI、Moonshot、Qwen、Perplexity 等供应商的模型。" },
      { question: "Private Mode 是什么？", answer: "Private Mode 表示 Tomverse 不会把对话保存到 Tomverse 数据库。为了生成回答，提示仍可能发送给 AI 供应商。" },
      { question: "可以附加文件吗？", answer: "可以。Tomverse 支持图片、PDF、Office 文档、Google Drive 文件以及其他允许的附件类型，具体能力取决于供应商支持。" },
    ],
    ctaTitle: "准备更聪明地比较了吗？",
    ctaDescription: "先从免费工作区开始，需要更强能力时再升级。",
  },
} satisfies Record<Language, LandingCopy>;

const featureIcons = [Layers3, FileText, Share2, LockKeyhole];
const useCaseIcons = [Search, Code2, BriefcaseBusiness, FileText];
const trustIcons = [ShieldCheck, Share2, LockKeyhole, FileText];

const CardGrid = ({
  items,
  icons,
}: {
  items: CardCopy[];
  icons: Array<typeof Layers3>;
}) => (
  <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
    {items.map((item, index) => {
      const Icon = icons[index] ?? Layers3;
      return (
        <article key={item.title} className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <Icon className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          <h3 className="mt-4 text-base font-black">{item.title}</h3>
          <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{item.description}</p>
        </article>
      );
    })}
  </div>
);

export function LandingPageContent() {
  const { lang } = useLanguage();
  const content = copy[lang];

  return (
    <main className="min-h-screen overflow-x-hidden bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader />

      <section className="relative">
        <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-7xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:px-8 lg:py-20">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-300">
              <Sparkles className="h-3.5 w-3.5" />
              {content.badge}
            </div>
            <h1 className="mt-6 max-w-4xl text-5xl font-black leading-[1.04] text-zinc-950 dark:text-white sm:text-6xl lg:text-7xl">
              {content.title}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">{content.description}</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/chat"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 text-sm font-black text-white shadow-lg shadow-blue-950/20 transition hover:bg-blue-500"
              >
                {content.primaryCta}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/pricing"
                className="inline-flex h-12 items-center justify-center rounded-xl border border-zinc-300 px-6 text-sm font-black text-zinc-800 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
              >
                {content.pricingCta}
              </Link>
            </div>
            <div className="mt-8 grid max-w-2xl gap-3 sm:grid-cols-3">
              {content.steps.map((step, index) => (
                <div key={step} className="flex items-center gap-2 text-sm font-semibold text-zinc-600 dark:text-zinc-300">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-black text-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
                    {index + 1}
                  </span>
                  {step}
                </div>
              ))}
            </div>
          </div>

          <div className="relative">
            <div className="overflow-hidden rounded-[2rem] border border-zinc-200 bg-zinc-950 p-3 shadow-2xl shadow-zinc-300/60 dark:border-zinc-800 dark:shadow-black/50">
              <div className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950">
                <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Bot className="h-4 w-4 text-blue-400" />
                    <span className="text-xs font-bold text-zinc-300">{content.previewTitle}</span>
                  </div>
                  <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-black text-emerald-300">
                    {content.previewCount}
                  </span>
                </div>
                <div className="grid gap-3 p-4 md:grid-cols-3">
                  {["GPT", "Claude", "Gemini"].map((model, index) => (
                    <div key={model} className="min-h-72 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4">
                      <div className="mb-5 flex items-center justify-between">
                        <span className="text-sm font-black text-white">{model}</span>
                        <span className="h-2 w-2 rounded-full bg-blue-400" />
                      </div>
                      <div className="space-y-3">
                        <div className="h-3 w-3/4 rounded-full bg-zinc-700" />
                        <div className="h-3 w-full rounded-full bg-zinc-800" />
                        <div className="h-3 w-5/6 rounded-full bg-zinc-800" />
                        <div className="mt-5 rounded-xl bg-blue-600 p-3 text-xs font-bold leading-5 text-white">
                          {content.previewAnswers[index]}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="border-y border-zinc-200 bg-zinc-50 py-20 dark:border-zinc-800 dark:bg-zinc-900/30">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-black sm:text-4xl">{content.featuresTitle}</h2>
            <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">{content.featuresDescription}</p>
          </div>
          <CardGrid items={content.features} icons={featureIcons} />
        </div>
      </section>

      <section className="py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-black sm:text-4xl">{content.useCasesTitle}</h2>
            <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">{content.useCasesDescription}</p>
          </div>
          <CardGrid items={content.useCases} icons={useCaseIcons} />
        </div>
      </section>

      <section className="border-y border-zinc-200 bg-zinc-950 py-20 text-white dark:border-zinc-800">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 sm:px-6 lg:grid-cols-[0.85fr_1.15fr] lg:px-8">
          <div>
            <Workflow className="h-7 w-7 text-blue-400" />
            <h2 className="mt-5 text-3xl font-black sm:text-4xl">{content.whyTitle}</h2>
            <p className="mt-4 text-base leading-7 text-zinc-300">{content.whyDescription}</p>
          </div>
          <div className="grid gap-4">
            {content.whyItems.map((item) => (
              <article key={item.title} className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
                <h3 className="font-black">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-300">{item.description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-black sm:text-4xl">{content.trustTitle}</h2>
            <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">{content.trustDescription}</p>
          </div>
          <CardGrid items={content.trustItems} icons={trustIcons} />
        </div>
      </section>

      <section id="models" className="border-y border-zinc-200 bg-zinc-50 py-20 dark:border-zinc-800 dark:bg-zinc-900/30">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-center">
            <div>
              <h2 className="text-3xl font-black sm:text-4xl">{content.modelsTitle}</h2>
              <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">{content.modelsDescription}</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {supportedModels.map((model) => (
                <article
                  key={model.name}
                  className="flex items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${model.className} text-lg font-black text-white shadow-sm ring-1 ring-zinc-200/70 dark:ring-zinc-800`}>
                    {model.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={model.image} alt={`${model.name} logo`} className="h-8 w-8 object-contain" />
                    ) : (
                      model.mark
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-base font-black text-zinc-950 dark:text-white">{model.name}</span>
                    <span className="block truncate text-xs font-bold text-zinc-500 dark:text-zinc-400">{model.detail}</span>
                  </span>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
            <div className="max-w-2xl">
              <h2 className="text-3xl font-black sm:text-4xl">{content.pricingTitle}</h2>
              <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">{content.pricingDescription}</p>
            </div>
            <Link href="/pricing" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 text-sm font-black text-white transition hover:bg-blue-500">
              {content.pricingCta}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="mt-10 grid gap-4 lg:grid-cols-3">
            {content.pricingPlans.map((plan, index) => (
              <article key={plan.title} className={`rounded-2xl border p-6 ${index === 1 ? "border-blue-500 bg-blue-600 text-white" : "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40"}`}>
                <h3 className="text-2xl font-black">{plan.title}</h3>
                <p className={`mt-2 text-3xl font-black ${index === 1 ? "text-white" : "text-zinc-950 dark:text-white"}`}>{plan.price}</p>
                <p className={`mt-3 text-sm leading-6 ${index === 1 ? "text-blue-50" : "text-zinc-600 dark:text-zinc-300"}`}>{plan.description}</p>
                <ul className="mt-5 space-y-3">
                  {plan.bullets.map((bullet) => (
                    <li key={bullet} className={`flex gap-3 text-sm font-semibold ${index === 1 ? "text-white" : "text-zinc-700 dark:text-zinc-200"}`}>
                      <CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${index === 1 ? "text-white" : "text-blue-600 dark:text-blue-400"}`} />
                      {bullet}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-zinc-200 bg-zinc-50 py-20 dark:border-zinc-800 dark:bg-zinc-900/30">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.6fr_1.4fr] lg:px-8">
          <div>
            <HelpCircle className="h-7 w-7 text-blue-600 dark:text-blue-400" />
            <h2 className="mt-5 text-3xl font-black sm:text-4xl">{content.faqTitle}</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {content.faqs.map((faq) => (
              <article key={faq.question} className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
                <h3 className="font-black">{faq.question}</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{faq.answer}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-blue-600 py-16 text-white">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-6 px-4 sm:px-6 md:flex-row md:items-center lg:px-8">
          <div>
            <h2 className="text-3xl font-black">{content.ctaTitle}</h2>
            <p className="mt-2 text-sm font-medium text-blue-100">{content.ctaDescription}</p>
          </div>
          <Link
            href="/chat"
            className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-white px-6 text-sm font-black text-blue-700 transition hover:bg-blue-50"
          >
            {content.app}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <MarketingFooter />
    </main>
  );
}
