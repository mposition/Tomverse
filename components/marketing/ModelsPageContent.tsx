"use client";

import Link from "next/link";
import { Activity, ArrowRight } from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { ENABLED_MODELS } from "@/lib/models";
import { getModelBrand } from "@/lib/modelBranding";
import { getModelBestFor, getModelExperienceStatus, getModelExperienceTags } from "@/lib/modelExperience";
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
    liveStatus: "View live service status",
    liveStatusDescription: "Check current provider availability and service-impacting incidents.",
  },
  ko: {
    eyebrow: "모델",
    title: "현재 사용 가능한 모델",
    description: "Tomverse AI에서 현재 활성화된 모델 카탈로그입니다. 공급자의 접근 권한, 가격, 모델명 변경에 따라 제공 여부가 달라질 수 있습니다.",
    provider: "공급자",
    tier: "등급",
    status: "상태",
    enabled: "사용 가능",
    liveStatus: "실시간 서비스 상태 보기",
    liveStatusDescription: "현재 제공자 가용성과 서비스 영향 장애를 확인하세요.",
  },
  zh: {
    eyebrow: "模型",
    title: "当前可用模型",
    description: "Tomverse AI 当前启用的模型目录。可用性可能会随着供应商访问权限、价格和模型名称变化而调整。",
    provider: "供应商",
    tier: "等级",
    status: "状态",
    enabled: "可用",
    liveStatus: "查看实时服务状态",
    liveStatusDescription: "查看当前供应商可用性和影响服务的事件。",
  },
  fr: {
    eyebrow: "Modèles",
    title: "Modèles actuellement disponibles",
    description: "Le catalogue de modèles actifs dans Tomverse AI. La disponibilité peut évoluer selon les accès, les prix et les noms de modèles des fournisseurs.",
    provider: "Fournisseur",
    tier: "Niveau",
    status: "Statut",
    enabled: "Disponible",
    liveStatus: "Voir l’état du service",
    liveStatusDescription: "Consultez la disponibilité des fournisseurs et les incidents en cours.",
  },
  de: {
    eyebrow: "Modelle",
    title: "Derzeit verfügbare Modelle",
    description: "Der aktive Modellkatalog in Tomverse AI. Die Verfügbarkeit kann sich je nach Anbieterzugriff, Preisen und Modellnamen ändern.",
    provider: "Anbieter",
    tier: "Stufe",
    status: "Status",
    enabled: "Verfügbar",
    liveStatus: "Live-Servicestatus ansehen",
    liveStatusDescription: "Prüfen Sie die Verfügbarkeit der Anbieter und aktuelle Störungen.",
  },
  es: {
    eyebrow: "Modelos",
    title: "Modelos disponibles actualmente",
    description: "El catálogo de modelos activos disponible en Tomverse AI. La disponibilidad puede cambiar según el acceso, los precios y los nombres de modelos de cada proveedor.",
    provider: "Proveedor",
    tier: "Nivel",
    status: "Estado",
    enabled: "Disponible",
    liveStatus: "Ver estado del servicio",
    liveStatusDescription: "Consulta la disponibilidad de proveedores y los incidentes actuales.",
  },
  pt: {
    eyebrow: "Modelos",
    title: "Modelos disponíveis atualmente",
    description: "O catálogo de modelos ativos disponível no Tomverse AI. A disponibilidade pode mudar conforme acesso, preços e nomes de modelos de cada provedor.",
    provider: "Provedor",
    tier: "Nível",
    status: "Status",
    enabled: "Disponível",
    liveStatus: "Ver status do serviço",
    liveStatusDescription: "Confira a disponibilidade dos provedores e incidentes atuais.",
  },
} satisfies Record<Language, Record<string, string>>;

export function ModelsPageContent() {
  const { lang, t } = useLanguage();
  const content = copy[lang];

  return (
    <main className="min-h-screen bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader maxWidth="max-w-6xl" />

      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:py-20">
        <div className="max-w-3xl">
          <p className="text-sm font-black uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">{content.eyebrow}</p>
          <h1 className="mt-4 text-4xl font-black leading-tight sm:text-6xl">{content.title}</h1>
          <p className="mt-5 text-lg leading-8 text-zinc-600 dark:text-zinc-300">{content.description}</p>
          <Link
            href="/status"
            data-testid="models-status-link"
            className="mt-7 inline-flex items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-left transition hover:bg-emerald-500/15"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">
              <Activity className="h-5 w-5" />
            </span>
            <span>
              <span className="block text-sm font-black text-emerald-700 dark:text-emerald-300">
                {content.liveStatus}
              </span>
              <span className="mt-0.5 block text-xs leading-5 text-zinc-600 dark:text-zinc-400">
                {content.liveStatusDescription}
              </span>
            </span>
            <ArrowRight className="ml-auto h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-300" />
          </Link>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ENABLED_MODELS.map((model) => {
            const brand = getModelBrand(model.provider);
            const tags = getModelExperienceTags(model);
            const status = getModelExperienceStatus(model);

            return (
            <article
              key={model.id}
              className="rounded-2xl border border-zinc-200 bg-zinc-50 p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900/40"
            >
              <div className="flex items-start gap-3">
                <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${brand.className} text-base font-black text-white shadow-sm ring-1 ring-zinc-200/70 dark:ring-zinc-800`}>
                  {brand.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={brand.image} alt={`${model.name} logo`} className="h-8 w-8 object-contain" />
                  ) : (
                    brand.mark
                  )}
                </span>
                <div>
                  <h2 className="font-black">{model.name}</h2>
                  <p className="text-xs font-semibold text-zinc-500">{model.id}</p>
                </div>
              </div>
              <p className="mt-4 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                {t(getModelBestFor(model))}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <span key={tag} className="rounded-full bg-white px-2 py-1 text-[10px] font-black text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-950 dark:ring-zinc-800">
                    {t(`modelTags.${tag}`)}
                  </span>
                ))}
              </div>
              <div className="mt-5 grid grid-cols-3 gap-3">
                <div>
                  <p className="text-[10px] font-bold uppercase text-zinc-500">{content.provider}</p>
                  <p className="mt-1 truncate text-sm font-black capitalize">{model.provider}</p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase text-zinc-500">{content.tier}</p>
                  <p className="mt-1 text-sm font-black">{t(`modelTiers.${model.tier.toLowerCase()}`)}</p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase text-zinc-500">{content.status}</p>
                  <p className={`mt-1 text-sm font-black ${status === "available" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>{content.enabled}</p>
                </div>
              </div>
            </article>
            );
          })}
        </div>
      </section>
      <MarketingFooter maxWidth="max-w-6xl" />
    </main>
  );
}
