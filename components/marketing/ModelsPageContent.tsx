"use client";

import { useLanguage, type Language } from "@/components/LanguageProvider";
import { ENABLED_MODELS } from "@/lib/models";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";

const copy = {
  en: {
    eyebrow: "Models",
    title: "Currently available models",
    description: "The active model catalogue available in Tomverse AI. Availability can change as providers update access, pricing, and model names.",
    provider: "Provider",
    tier: "Tier",
    status: "Status",
    enabled: "Available",
  },
  ko: {
    eyebrow: "모델",
    title: "현재 사용 가능한 모델",
    description: "Tomverse AI에서 현재 활성화된 모델 카탈로그입니다. 공급자의 접근 권한, 가격, 모델명 변경에 따라 제공 여부가 달라질 수 있습니다.",
    provider: "공급자",
    tier: "등급",
    status: "상태",
    enabled: "사용 가능",
  },
  zh: {
    eyebrow: "模型",
    title: "当前可用模型",
    description: "Tomverse AI 当前启用的模型目录。可用性可能会随着供应商访问权限、价格和模型名称变化而调整。",
    provider: "供应商",
    tier: "等级",
    status: "状态",
    enabled: "可用",
  },
} satisfies Record<Language, Record<string, string>>;

export function ModelsPageContent() {
  const { lang } = useLanguage();
  const content = copy[lang];

  return (
    <main className="min-h-screen bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader maxWidth="max-w-6xl" />

      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:py-20">
        <div className="max-w-3xl">
          <p className="text-sm font-black uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">{content.eyebrow}</p>
          <h1 className="mt-4 text-4xl font-black leading-tight sm:text-6xl">{content.title}</h1>
          <p className="mt-5 text-lg leading-8 text-zinc-600 dark:text-zinc-300">{content.description}</p>
        </div>

        <div className="mt-12 grid gap-3">
          {ENABLED_MODELS.map((model) => (
            <article
              key={model.id}
              className="grid gap-4 rounded-2xl border border-zinc-200 bg-zinc-50 p-5 dark:border-zinc-800 dark:bg-zinc-900/40 md:grid-cols-[1fr_160px_120px_120px] md:items-center"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-sm font-black shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-950 dark:ring-zinc-800">
                  {model.icon}
                </span>
                <div>
                  <h2 className="font-black">{model.name}</h2>
                  <p className="text-xs font-semibold text-zinc-500">{model.id}</p>
                </div>
              </div>
              <div>
                <p className="text-xs font-bold uppercase text-zinc-500">{content.provider}</p>
                <p className="mt-1 text-sm font-black capitalize">{model.provider}</p>
              </div>
              <div>
                <p className="text-xs font-bold uppercase text-zinc-500">{content.tier}</p>
                <p className="mt-1 text-sm font-black">{model.tier}</p>
              </div>
              <div>
                <p className="text-xs font-bold uppercase text-zinc-500">{content.status}</p>
                <p className="mt-1 text-sm font-black text-emerald-600 dark:text-emerald-400">{content.enabled}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
      <MarketingFooter maxWidth="max-w-6xl" />
    </main>
  );
}
