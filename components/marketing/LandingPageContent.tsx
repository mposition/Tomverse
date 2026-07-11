"use client";

import Link from "next/link";
import {
  ArrowRight,
  Bot,
  FileText,
  Layers3,
  LockKeyhole,
  Share2,
  Sparkles,
} from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";

const supportedModels = ["GPT", "Claude", "Gemini", "DeepSeek", "Llama", "Grok", "Kimi", "Qwen"];

type LandingCopy = {
  nav: { features: string; models: string; pricing: string; privacy: string };
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
  features: Array<{ title: string; description: string }>;
  modelsTitle: string;
  modelsDescription: string;
  ctaTitle: string;
  ctaDescription: string;
  footer: {
    privacy: string;
    pricing: string;
    app: string;
    faq: string;
    terms: string;
    refund: string;
    models: string;
    safety: string;
    about: string;
    support: string;
  };
};

const copy = {
  en: {
    nav: { features: "Features", models: "Models", pricing: "Pricing", privacy: "Privacy" },
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
      {
        title: "Compare AI models side by side",
        description: "Ask once and compare answers from multiple leading models in one focused workspace.",
      },
      {
        title: "Work with files and context",
        description: "Attach images, PDFs, office documents, and Google Drive files when your task needs real material.",
      },
      {
        title: "Share polished conversations",
        description: "Turn useful chats into read-only public pages or download them as clean text records.",
      },
      {
        title: "Built for privacy-aware work",
        description: "Use locked chats, Private Mode, rate limits, and hardened security controls for safer daily use.",
      },
    ],
    modelsTitle: "Built around the model market.",
    modelsDescription:
      "New models arrive constantly. Tomverse keeps model choice centralized so users can compare the right options without rebuilding their workflow.",
    ctaTitle: "Ready to compare smarter?",
    ctaDescription: "Start with the free workspace and upgrade when you need more power.",
    footer: { privacy: "Privacy", pricing: "Pricing", app: "App", faq: "FAQ", terms: "Terms", refund: "Refund", models: "Models", safety: "Safety", about: "About", support: "Support" },
  },
  ko: {
    nav: { features: "기능", models: "모델", pricing: "요금", privacy: "개인정보" },
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
      {
        title: "AI 모델을 나란히 비교",
        description: "한 번 질문하고 여러 최신 모델의 답변을 한 화면에서 집중해서 비교할 수 있습니다.",
      },
      {
        title: "파일과 맥락까지 함께 작업",
        description: "이미지, PDF, 오피스 문서, Google Drive 파일을 첨부해 실제 자료 기반으로 질문할 수 있습니다.",
      },
      {
        title: "대화를 깔끔하게 공유",
        description: "유용한 대화를 읽기 전용 공개 페이지로 만들거나 정리된 텍스트 파일로 다운로드할 수 있습니다.",
      },
      {
        title: "프라이버시를 고려한 업무 환경",
        description: "잠금 대화, Private Mode, 사용량 제한, 보안 헤더 등 안전한 일상 사용을 위한 기본기를 갖췄습니다.",
      },
    ],
    modelsTitle: "빠르게 변하는 모델 시장을 기준으로 설계.",
    modelsDescription:
      "새 모델은 계속 등장합니다. Tomverse는 모델 선택을 중앙에서 관리해 사용자가 워크플로를 바꾸지 않고 적절한 모델을 비교할 수 있게 합니다.",
    ctaTitle: "더 똑똑하게 비교해볼까요?",
    ctaDescription: "무료 워크스페이스로 시작하고 더 강력한 기능이 필요할 때 업그레이드하세요.",
    footer: { privacy: "개인정보", pricing: "요금", app: "앱", faq: "FAQ", terms: "이용약관", refund: "환불", models: "모델", safety: "안전", about: "소개", support: "지원" },
  },
  zh: {
    nav: { features: "功能", models: "模型", pricing: "价格", privacy: "隐私" },
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
      {
        title: "并排比较 AI 模型",
        description: "一次提问，在同一个专注工作区比较多个领先模型的回答。",
      },
      {
        title: "结合文件和上下文工作",
        description: "当任务需要真实资料时，可附加图片、PDF、办公文档和 Google Drive 文件。",
      },
      {
        title: "分享精美的对话",
        description: "把有用的聊天转成只读公开页面，或下载为整洁的文本记录。",
      },
      {
        title: "为注重隐私的工作而构建",
        description: "通过锁定聊天、Private Mode、速率限制和安全控制，让日常使用更安心。",
      },
    ],
    modelsTitle: "围绕快速变化的模型市场构建。",
    modelsDescription:
      "新模型不断出现。Tomverse 将模型选择集中管理，让用户不用重建流程也能比较合适的选项。",
    ctaTitle: "准备更聪明地比较了吗？",
    ctaDescription: "先从免费工作区开始，需要更强能力时再升级。",
    footer: { privacy: "隐私", pricing: "价格", app: "应用", faq: "FAQ", terms: "条款", refund: "退款", models: "模型", safety: "安全", about: "关于", support: "支持" },
  },
} satisfies Record<Language, LandingCopy>;

const featureIcons = [Layers3, FileText, Share2, LockKeyhole];

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
          <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {content.features.map((feature, index) => {
              const Icon = featureIcons[index] ?? Layers3;
              return (
                <article key={feature.title} className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
                  <Icon className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                  <h3 className="mt-4 text-base font-black">{feature.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{feature.description}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section id="models" className="py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-center">
            <div>
              <h2 className="text-3xl font-black sm:text-4xl">{content.modelsTitle}</h2>
              <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">{content.modelsDescription}</p>
            </div>
            <div className="flex flex-wrap gap-3">
              {supportedModels.map((model) => (
                <span
                  key={model}
                  className="rounded-full border border-zinc-200 bg-zinc-50 px-4 py-2 text-sm font-bold text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
                >
                  {model}
                </span>
              ))}
            </div>
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
