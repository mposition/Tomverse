"use client";

import Link from "next/link";
import { CheckCircle2, Minus } from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";
import { UpgradeInterestButton } from "@/components/marketing/UpgradeInterestButton";

type PlanCopy = {
  name: string;
  eyebrow: string;
  price: string;
  period: string;
  description: string;
  cta: string;
  href: string;
  highlighted?: boolean;
  badge?: string;
  usage: string;
  features: string[];
};

type PricingCopy = {
  eyebrow: string;
  title: string;
  description: string;
  billingNote: string;
  compareTitle: string;
  compareDescription: string;
  table: {
    feature: string;
    free: string;
    pro: string;
    max: string;
    rows: Array<{ label: string; free: string; pro: string; max: string }>;
  };
  faqTitle: string;
  faqs: Array<{ question: string; answer: string }>;
  note: string;
  plans: PlanCopy[];
};

const copy: { en: PricingCopy } & Partial<Record<Language, PricingCopy>> = {
  en: {
    eyebrow: "Pricing",
    title: "Choose the right level of AI power.",
    description:
      "Start free, then upgrade when you need more models, higher limits, file workflows, and premium model access.",
    billingNote: "Billing is not enabled yet. Prices below show the intended product direction.",
    compareTitle: "Compare what each plan unlocks",
    compareDescription:
      "Tomverse plans are designed around model access, usage allowance, file workflows, and sharing controls.",
    table: {
      feature: "Feature",
      free: "무료",
      pro: "Pro",
      max: "Max",
      rows: [
        { label: "Model access", free: "Free and Pro model tiers", pro: "All models with Pro usage limits", max: "All models with the largest allowance" },
        { label: "Multi-model comparison", free: "Up to 3 models", pro: "Up to 3 models", max: "Up to 3 models" },
        { label: "File attachments", free: "Images, PDFs, Office, Drive", pro: "Images, PDFs, Office, Drive", max: "Higher file and context limits" },
        { label: "Conversation sharing", free: "Share and download", pro: "Share and download", max: "Share, download, priority limits" },
        { label: "Usage allowance", free: "Free daily and monthly limits", pro: "Higher daily and monthly usage", max: "No daily message limit" },
      ],
    },
    faqTitle: "Pricing questions",
    faqs: [
      {
        question: "Can I keep using Tomverse for free?",
        answer: "Yes. The Free plan is intended for light daily use with access to Free and Pro model tiers within usage limits.",
      },
      {
        question: "What happens when billing launches?",
        answer: "We will show the final prices, renewal terms, and cancellation details before asking users to subscribe.",
      },
      {
        question: "Does Pro restrict which models I can choose?",
        answer: "Pro is intended to unlock the available model catalogue. Higher-cost models are managed through usage and cost limits rather than a simple model picker block.",
      },
    ],
    note:
      "Final prices, tax handling, regional availability, and refund terms will be confirmed before paid subscriptions launch.",
    plans: [
      {
        name: "Free",
        eyebrow: "For starting out",
        price: "$0",
        period: "per month",
        description: "A simple way to try Tomverse and use selected AI models for light daily work.",
        cta: "Start free",
        href: "/chat",
        usage: "Basic daily usage",
        features: [
          "Access to Free and Pro model tiers",
          "Compare up to 3 models",
          "Basic chat history",
          "File attachments, sharing, and downloads after login",
          "Good for light personal use",
        ],
      },
      {
        name: "Pro",
        eyebrow: "For everyday productivity",
        price: "Coming soon",
        period: "monthly subscription",
        description: "For people who compare models, attach files, and reuse conversations throughout the week.",
        cta: "Open app",
        href: "/chat",
        highlighted: true,
        badge: "Recommended",
        usage: "Higher usage than Free",
        features: [
          "Access to all available model tiers",
          "Compare up to 3 models side by side",
          "File attachments and Google Drive files",
          "Share and download conversations",
          "Higher daily and monthly limits",
        ],
      },
      {
        name: "Max",
        eyebrow: "For heavier AI workflows",
        price: "Coming soon",
        period: "monthly subscription",
        description: "For power users who need premium model tiers, larger allowances, and priority room to work.",
        cta: "Open app",
        href: "/chat",
        usage: "Largest usage allowance",
        features: [
          "Access to Free, Pro, and Max model tiers",
          "Highest usage allowance",
          "Higher attachment and context limits",
          "Priority access to advanced model tiers",
          "Prepared for future team-ready features",
        ],
      },
    ],
  },
  ko: {
    eyebrow: "요금",
    title: "필요한 만큼 AI 파워를 선택하세요.",
    description:
      "무료로 시작하고, 더 많은 모델과 높은 사용량, 파일 워크플로, 프리미엄 모델 접근이 필요할 때 업그레이드하세요.",
    billingNote: "아직 결제는 활성화되어 있지 않습니다. 아래 가격 정보는 제품 방향을 보여주는 안내입니다.",
    compareTitle: "요금제별 제공 범위 비교",
    compareDescription:
      "Tomverse 요금제는 모델 접근 권한, 사용량, 파일 워크플로, 공유 기능을 기준으로 나뉩니다.",
    table: {
      feature: "항목",
      free: "Free",
      pro: "Pro",
      max: "Max",
      rows: [
        { label: "모델 접근", free: "Free 및 Pro 모델 등급", pro: "전체 모델 접근, Pro 사용량 한도", max: "전체 모델 접근, 최대 사용량 한도" },
        { label: "멀티 모델 비교", free: "최대 3개 모델", pro: "최대 3개 모델", max: "최대 3개 모델" },
        { label: "파일 첨부", free: "이미지, PDF, Office, Drive", pro: "이미지, PDF, Office, Drive", max: "더 높은 파일/컨텍스트 한도" },
        { label: "대화 공유", free: "공유 및 다운로드", pro: "공유 및 다운로드", max: "공유, 다운로드, 우선 한도" },
        { label: "사용량", free: "Free 일일/월간 한도", pro: "더 높은 일일/월간 사용량", max: "일일 메시지 무제한" },
      ],
    },
    faqTitle: "요금 관련 질문",
    faqs: [
      {
        question: "무료로 계속 사용할 수 있나요?",
        answer: "네. 무료 요금제는 사용량 한도 안에서 Free 및 Pro 모델 등급을 가볍게 사용할 수 있도록 제공됩니다.",
      },
      {
        question: "결제가 시작되면 어떻게 되나요?",
        answer: "구독을 요청하기 전에 최종 가격, 갱신 조건, 취소 조건을 명확히 안내하겠습니다.",
      },
      {
        question: "Pro에서 선택 가능한 모델을 제한하나요?",
        answer: "Pro는 사용 가능한 모델 카탈로그 접근을 열어두는 방향이 좋습니다. 고가 모델은 모델 선택 차단보다 사용량과 비용 한도로 관리하는 편이 Tomverse의 비교 경험에 더 잘 맞습니다.",
      },
    ],
    note:
      "최종 가격, 세금 처리, 지역별 제공 여부, 환불 조건은 유료 구독 출시 전에 확정해 안내하겠습니다.",
    plans: [
      {
        name: "무료",
        eyebrow: "처음 시작하는 사용자",
        price: "$0",
        period: "월",
        description: "Tomverse를 체험하고 선택된 AI 모델로 가벼운 일상 작업을 시작하기 좋은 요금제입니다.",
        cta: "무료로 시작",
        href: "/chat",
        usage: "기본 일일 사용량",
        features: [
          "Free 및 Pro 모델 등급 접근",
          "최대 3개 모델 동시 비교",
          "기본 대화 기록",
          "로그인 후 파일 첨부, 공유, 다운로드",
          "가벼운 개인 사용에 적합",
        ],
      },
      {
        name: "Pro",
        eyebrow: "일상 생산성",
        price: "준비 중",
        period: "월 구독",
        description: "여러 모델을 비교하고, 파일을 첨부하며, 대화를 반복해서 활용하는 사용자에게 적합합니다.",
        cta: "앱 열기",
        href: "/chat",
        highlighted: true,
        badge: "추천",
        usage: "무료보다 높은 사용량",
        features: [
          "사용 가능한 전체 모델 등급 접근",
          "최대 3개 모델 동시 비교",
          "파일 첨부 및 Google Drive 파일",
          "대화 공유 및 다운로드",
          "더 높은 일일/월간 사용량",
        ],
      },
      {
        name: "Max",
        eyebrow: "고강도 AI 워크플로",
        price: "준비 중",
        period: "월 구독",
        description: "프리미엄 모델 등급, 더 큰 사용량, 더 여유로운 작업 공간이 필요한 파워 유저용입니다.",
        cta: "앱 열기",
        href: "/chat",
        usage: "가장 큰 사용량 한도",
        features: [
          "무료, Pro, Max 전체 모델 등급 접근",
          "가장 높은 사용량 한도",
          "더 높은 첨부파일 및 컨텍스트 한도",
          "고급 모델 등급 우선 접근",
          "향후 팀 기능 준비",
        ],
      },
    ],
  },
  zh: {
    eyebrow: "价格",
    title: "选择适合你的 AI 能力等级。",
    description:
      "从免费开始；当你需要更多模型、更高额度、文件工作流和高级模型访问时再升级。",
    billingNote: "目前尚未启用付款。以下价格信息展示的是产品方向。",
    compareTitle: "比较每个方案解锁的能力",
    compareDescription:
      "Tomverse 方案围绕模型访问、使用额度、文件工作流和分享控制来设计。",
    table: {
      feature: "功能",
      free: "Free",
      pro: "Pro",
      max: "Max",
      rows: [
        { label: "模型访问", free: "Free 模型", pro: "全部模型，Pro 使用额度", max: "全部模型，最大使用额度" },
        { label: "多模型比较", free: "1 个模型", pro: "最多 3 个模型", max: "最多 3 个模型" },
        { label: "文件附件", free: "基础图片", pro: "图片、PDF、Office、Drive", max: "更高文件和上下文限制" },
        { label: "对话分享", free: "-", pro: "分享和下载", max: "分享、下载、优先额度" },
        { label: "使用额度", free: "基础每日额度", pro: "更高每日和每月额度", max: "最大使用额度" },
      ],
    },
    faqTitle: "价格问题",
    faqs: [
      {
        question: "我可以继续免费使用 Tomverse 吗？",
        answer: "可以。Free 方案面向轻量日常使用，并提供部分免费模型访问。",
      },
      {
        question: "付费上线后会怎样？",
        answer: "在要求用户订阅之前，我们会清楚展示最终价格、续费条款和取消方式。",
      },
      {
        question: "Pro 会限制可选择的模型吗？",
        answer: "Pro 的方向是开放可用模型目录。高成本模型更适合通过使用额度和成本限制来管理，而不是直接阻止模型选择。",
      },
    ],
    note:
      "最终价格、税费、地区可用性和退款条款会在付费订阅上线前确认。",
    plans: [
      {
        name: "Free",
        eyebrow: "适合开始使用",
        price: "$0",
        period: "每月",
        description: "用于体验 Tomverse，并使用部分 AI 模型完成轻量日常工作。",
        cta: "免费开始",
        href: "/chat",
        usage: "基础每日额度",
        features: [
          "访问 Free 模型等级",
          "单模型聊天工作区",
          "基础聊天历史",
          "访客和登录模式",
          "适合轻量个人使用",
        ],
      },
      {
        name: "Pro",
        eyebrow: "日常生产力",
        price: "即将推出",
        period: "月度订阅",
        description: "适合经常比较模型、附加文件并复用对话的用户。",
        cta: "打开应用",
        href: "/chat",
        highlighted: true,
        badge: "推荐",
        usage: "高于 Free 的额度",
        features: [
          "访问全部可用模型等级",
          "最多并排比较 3 个模型",
          "文件附件和 Google Drive 文件",
          "分享和下载对话",
          "更高每日和每月额度",
        ],
      },
      {
        name: "Max",
        eyebrow: "高强度 AI 工作流",
        price: "即将推出",
        period: "月度订阅",
        description: "适合需要高级模型等级、更大额度和更多工作空间的高频用户。",
        cta: "打开应用",
        href: "/chat",
        usage: "最大使用额度",
        features: [
          "访问 Free、Pro 和 Max 全部模型等级",
          "最高使用额度",
          "更高附件和上下文限制",
          "优先访问高级模型等级",
          "为未来团队功能做准备",
        ],
      },
    ],
  },
};

export function PricingPageContent() {
  const { lang, t } = useLanguage();
  const content = copy[lang] ?? copy.en;

  return (
    <main className="min-h-screen bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader />

      <section className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-4xl text-center">
          <p className="text-sm font-black uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">{content.eyebrow}</p>
          <h1 className="mt-4 text-4xl font-black leading-tight sm:text-6xl">{content.title}</h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">{content.description}</p>
          <p className="mt-5 rounded-full bg-zinc-100 px-4 py-2 text-sm font-bold text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
            {content.billingNote}
          </p>
        </div>

        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          {content.plans.map((plan) => (
            <article
              key={plan.name}
              className={`relative flex min-h-full flex-col rounded-[1.75rem] border p-6 shadow-sm ${
                plan.highlighted
                  ? "border-blue-500 bg-blue-600 text-white shadow-2xl shadow-blue-950/20"
                  : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40"
              }`}
            >
              <div className="flex min-h-8 items-start justify-between gap-3">
                <p className={`text-xs font-black uppercase tracking-[0.18em] ${plan.highlighted ? "text-blue-100" : "text-blue-600 dark:text-blue-400"}`}>
                  {plan.eyebrow}
                </p>
                {plan.badge && (
                  <span className="shrink-0 rounded-full bg-white/15 px-3 py-1 text-xs font-black text-white ring-1 ring-white/20">
                    {plan.badge}
                  </span>
                )}
              </div>
              <h2 className="mt-4 text-3xl font-black">{plan.name}</h2>
              <p className={`mt-3 min-h-14 text-sm leading-6 ${plan.highlighted ? "text-blue-50" : "text-zinc-600 dark:text-zinc-300"}`}>
                {plan.description}
              </p>
              <div className="mt-8">
                <span className="text-4xl font-black">{plan.price}</span>
                <span className={`ml-2 text-sm font-bold ${plan.highlighted ? "text-blue-100" : "text-zinc-500 dark:text-zinc-400"}`}>
                  {plan.period}
                </span>
              </div>
              <p className={`mt-3 text-sm font-black ${plan.highlighted ? "text-blue-50" : "text-zinc-700 dark:text-zinc-200"}`}>
                {plan.usage}
              </p>
              {plan.price === "$0" ? (
                <Link
                  href={plan.href}
                  className={`mt-8 inline-flex h-12 w-full items-center justify-center rounded-xl text-sm font-black transition ${
                    plan.highlighted
                      ? "bg-white text-blue-700 hover:bg-blue-50"
                      : "border border-zinc-300 text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
                  }`}
                >
                  {plan.cta}
                </Link>
              ) : (
                <UpgradeInterestButton
                  plan={plan.name === "Max" ? "Max" : "Pro"}
                  className={`mt-8 inline-flex h-12 w-full items-center justify-center rounded-xl text-sm font-black transition ${
                    plan.highlighted
                      ? "bg-white text-blue-700 hover:bg-blue-50"
                      : "border border-zinc-300 text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
                  }`}
                >
                  {t("billing.joinWaitlist")}
                </UpgradeInterestButton>
              )}
              <ul className="mt-8 space-y-3">
                {plan.features.map((feature) => (
                  <li key={feature} className={`flex gap-3 text-sm font-semibold leading-6 ${plan.highlighted ? "text-white" : "text-zinc-700 dark:text-zinc-300"}`}>
                    <CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${plan.highlighted ? "text-white" : "text-blue-600 dark:text-blue-400"}`} />
                    {feature}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <section className="mt-16 rounded-[2rem] border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/40 sm:p-6">
          <div className="max-w-3xl">
            <h2 className="text-3xl font-black">{content.compareTitle}</h2>
            <p className="mt-3 text-sm leading-7 text-zinc-600 dark:text-zinc-300">{content.compareDescription}</p>
          </div>
          <div className="mt-8 overflow-x-auto">
            <table className="w-full min-w-[760px] border-separate border-spacing-0 text-left text-sm">
              <thead>
                <tr>
                  {[content.table.feature, content.table.free, content.table.pro, content.table.max].map((heading) => (
                    <th key={heading} className="border-b border-zinc-200 px-4 py-3 font-black text-zinc-900 dark:border-zinc-800 dark:text-white">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {content.table.rows.map((row) => (
                  <tr key={row.label}>
                    <td className="border-b border-zinc-200 px-4 py-4 font-black dark:border-zinc-800">{row.label}</td>
                    {[row.free, row.pro, row.max].map((value, index) => (
                      <td key={`${row.label}-${index}`} className="border-b border-zinc-200 px-4 py-4 font-semibold text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
                        {value === "-" ? <Minus className="h-4 w-4 text-zinc-400" /> : value}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-16 grid gap-5 lg:grid-cols-[0.7fr_1.3fr]">
          <h2 className="text-3xl font-black">{content.faqTitle}</h2>
          <div className="grid gap-4">
            {content.faqs.map((faq) => (
              <article key={faq.question} className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/40">
                <h3 className="font-black">{faq.question}</h3>
                <p className="mt-2 text-sm leading-7 text-zinc-600 dark:text-zinc-300">{faq.answer}</p>
              </article>
            ))}
          </div>
        </section>

        <div className="mt-10 rounded-2xl border border-zinc-200 bg-zinc-50 p-5 text-sm leading-7 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300">
          {content.note}
        </div>
      </section>
      <MarketingFooter />
    </main>
  );
}
