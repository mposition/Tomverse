"use client";

import Link from "next/link";
import { Activity, ExternalLink } from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import { getModelUsageProfile } from "@/lib/models";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { getModelBrand } from "@/lib/modelBranding";
import { getModelBestFor, getModelExperienceStatus, getModelExperienceTags } from "@/lib/modelExperience";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";
import { statusLinkLabel, statusNewTabCopy } from "./statusLinkCopy";

const copy = {
  en: {
    eyebrow: "Models",
    title: "Find a model for your question.",
    description: "Compare suggested uses, base credits and the plan needed for access. Explore the models you can select in Tomverse Chat and Review, then check current availability and usage in the app’s model selector.",
    provider: "Provider",
    usageClass: "Credit category",
    baseCharge: "Base credits for a short request",
    creditUnit: "credits",
    usageNote: "Credit categories are separate from subscription plans. Long conversations and files can apply a 1.5×, 2× or 3× input-size multiplier to base credits. Suggested uses and tags are a guide, not a performance ranking. EU refers to the provider’s base, not a guarantee of data residency. Guest-access models also have usage limits.",
    status: "Status",
    enabled: "Available",
    liveStatus: "View live service status",
    liveStatusDescription: "Check current provider availability and service-impacting incidents.",

    limited: "Limited availability",
    unavailable: "Currently unavailable",
    minimumPlan: "Access starts with",
  },
  ko: {
    eyebrow: "모델",
    title: "질문에 맞는 모델을 찾아보세요.",
    description: "추천 활용, 기본 크레딧과 이용에 필요한 플랜을 비교해 보세요. Tomverse Chat과 Review에서 선택할 수 있는 모델을 확인하고, 현재 제공 여부와 사용량은 앱의 모델 선택기에서 다시 확인할 수 있습니다.",
    provider: "공급자",
    usageClass: "크레딧 사용 등급",
    baseCharge: "짧은 요청의 기본 크레딧",
    creditUnit: "크레딧",
    usageNote: "크레딧 사용 등급은 요금제와 별개입니다. 긴 대화와 파일은 입력 크기에 따라 기본 크레딧의 1.5배, 2배 또는 3배를 사용할 수 있습니다. 추천 활용과 태그는 비교를 돕는 참고이며 성능 순위가 아닙니다. EU는 공급자 기반 지역을 뜻하며 데이터 저장 위치를 보장하지 않습니다. 게스트 이용 모델에도 사용 한도가 적용됩니다.",
    status: "상태",
    enabled: "사용 가능",
    liveStatus: "실시간 서비스 상태 보기",
    liveStatusDescription: "현재 제공자 가용성과 서비스 영향 장애를 확인하세요.",

    limited: "제공 제한",
    unavailable: "현재 이용 불가",
    minimumPlan: "이용 시작 플랜",
  },
  zh: {
    eyebrow: "模型",
    title: "找到适合问题的模型。",
    description: "比较建议用途、基础积分和使用所需套餐。了解 Tomverse Chat 与 Review 中可选的模型，并在应用的模型选择器中再次确认当前可用情况与用量。",
    provider: "供应商",
    usageClass: "积分消耗等级",
    baseCharge: "短请求基础积分",
    creditUnit: "积分",
    usageNote: "积分等级与订阅套餐不同。长对话和文件可能按输入大小消耗基础积分的 1.5、2 或 3 倍。建议用途和标签仅供比较参考，不代表性能排名。EU 指供应商所在地，不保证数据存储位置。访客可用模型也受用量限制。",
    status: "状态",
    enabled: "可用",
    liveStatus: "查看实时服务状态",
    liveStatusDescription: "查看当前供应商可用性和影响服务的事件。",

    limited: "可用性受限",
    unavailable: "暂不可用",
    minimumPlan: "使用所需套餐",
  },
  fr: {
    eyebrow: "Modèles",
    title: "Trouvez un modèle pour votre question.",
    description: "Comparez les usages suggérés, les crédits de base et l’offre requise. Découvrez les modèles de Tomverse Chat et Review, puis vérifiez leur disponibilité et leur consommation dans le sélecteur de l’application.",
    provider: "Fournisseur",
    usageClass: "Catégorie de consommation",
    baseCharge: "Crédits de base pour une demande courte",
    creditUnit: "crédits",
    usageNote: "Les catégories de consommation sont distinctes des offres. Les longs échanges et les fichiers peuvent multiplier les crédits de base par 1,5, 2 ou 3 selon la taille d’entrée. Usages et tags servent de repères, sans classement de performances. UE indique la base du fournisseur, sans garantir la localisation des données. L’accès invité reste soumis à des limites.",
    status: "Statut",
    enabled: "Disponible",
    liveStatus: "Voir l’état du service",
    liveStatusDescription: "Consultez la disponibilité des fournisseurs et les incidents en cours.",

    limited: "Disponibilité limitée",
    unavailable: "Indisponible actuellement",
    minimumPlan: "Accès à partir de",
  },
  de: {
    eyebrow: "Modelle",
    title: "Finden Sie ein Modell für Ihre Frage.",
    description: "Vergleichen Sie vorgeschlagene Einsatzbereiche, Basis-Credits und den erforderlichen Tarif. Entdecken Sie die Modelle in Tomverse Chat und Review und prüfen Sie Verfügbarkeit und Verbrauch in der Modellauswahl der App.",
    provider: "Anbieter",
    usageClass: "Credit-Kategorie",
    baseCharge: "Basis-Credits für eine kurze Anfrage",
    creditUnit: "Credits",
    usageNote: "Credit-Kategorien sind unabhängig vom Tarif. Lange Gespräche und Dateien können den Basisverbrauch je nach Eingabegröße mit 1,5, 2 oder 3 multiplizieren. Einsatzbereiche und Tags dienen zur Orientierung, nicht als Leistungsrangliste. EU bezeichnet den Standort des Anbieters und garantiert keinen Datenspeicherort. Auch Gastmodelle haben Nutzungslimits.",
    status: "Status",
    enabled: "Verfügbar",
    liveStatus: "Live-Servicestatus ansehen",
    liveStatusDescription: "Prüfen Sie die Verfügbarkeit der Anbieter und aktuelle Störungen.",

    limited: "Eingeschränkt verfügbar",
    unavailable: "Derzeit nicht verfügbar",
    minimumPlan: "Zugang ab",
  },
  es: {
    eyebrow: "Modelos",
    title: "Encuentra un modelo para tu pregunta.",
    description: "Compara usos sugeridos, créditos base y el plan necesario. Explora los modelos de Tomverse Chat y Review y confirma su disponibilidad y consumo en el selector de la aplicación.",
    provider: "Proveedor",
    usageClass: "Categoría de consumo",
    baseCharge: "Créditos base de una solicitud corta",
    creditUnit: "créditos",
    usageNote: "Las categorías de consumo son distintas de los planes. Los historiales largos y los archivos pueden multiplicar los créditos base por 1,5, 2 o 3 según el tamaño de entrada. Los usos y etiquetas son orientativos, sin clasificación de rendimiento. UE indica la sede del proveedor y no garantiza dónde se guardan los datos. El acceso de invitados también tiene límites.",
    status: "Estado",
    enabled: "Disponible",
    liveStatus: "Ver estado del servicio",
    liveStatusDescription: "Consulta la disponibilidad de proveedores y los incidentes actuales.",

    limited: "Disponibilidad limitada",
    unavailable: "No disponible actualmente",
    minimumPlan: "Acceso desde",
  },
  pt: {
    eyebrow: "Modelos",
    title: "Encontre um modelo para sua pergunta.",
    description: "Compare usos sugeridos, créditos-base e o plano necessário. Conheça os modelos do Tomverse Chat e Review e confira a disponibilidade e o consumo no seletor do aplicativo.",
    provider: "Provedor",
    usageClass: "Categoria de consumo",
    baseCharge: "Créditos-base de uma solicitação curta",
    creditUnit: "créditos",
    usageNote: "As categorias de consumo são separadas dos planos. Conversas longas e arquivos podem multiplicar os créditos-base por 1,5, 2 ou 3 conforme o tamanho da entrada. Usos e etiquetas são orientativos, sem classificação de desempenho. UE indica a base do provedor e não garante onde os dados são armazenados. O acesso de visitantes também tem limites.",
    status: "Status",
    enabled: "Disponível",
    liveStatus: "Ver status do serviço",
    liveStatusDescription: "Confira a disponibilidade dos provedores e incidentes atuais.",

    limited: "Disponibilidade limitada",
    unavailable: "Indisponível no momento",
    minimumPlan: "Acesso a partir de",
  },
} satisfies Record<Language, Record<string, string>>;

export function ModelsPageContent() {
  const { enabledModels: ENABLED_MODELS } = useModelCatalog();
  const { lang, t } = useLanguage();
  const content = copy[lang];

  return (
    <main className="min-h-screen bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader maxWidth="max-w-6xl" />

      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:py-20">
        <div className="max-w-3xl">
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">{content.eyebrow}</p>
          <h1 className="mt-4 text-4xl font-black leading-tight sm:text-6xl">{content.title}</h1>
          <p className="mt-5 text-lg leading-8 text-zinc-600 dark:text-zinc-300">{content.description}</p>
          <p className="mt-5 rounded-2xl border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-sm font-semibold leading-6 text-blue-800 dark:text-blue-200">
            {content.usageNote}
          </p>
          <Link
            href={`/status?lang=${encodeURIComponent(lang)}`}
            target="_blank"
            rel="noopener noreferrer"
            prefetch={false}
            aria-label={statusLinkLabel(content.liveStatus, lang)}
            title={statusNewTabCopy[lang]}
            data-testid="models-status-link"
            className="mt-7 inline-flex max-w-full items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-left transition hover:bg-emerald-500/15 [overflow-wrap:anywhere] max-[240px]:flex-col max-[240px]:items-start"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">
              <Activity className="h-5 w-5" />
            </span>
            <span className="min-w-0 max-w-full">
              <span className="block text-sm font-bold text-emerald-700 dark:text-emerald-300">
                {content.liveStatus}
              </span>
              <span className="mt-0.5 block text-xs leading-5 text-zinc-600 dark:text-zinc-400">
                {content.liveStatusDescription}
              </span>
            </span>
            <ExternalLink className="ml-auto h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-300" aria-hidden="true" />
          </Link>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ENABLED_MODELS.map((model) => {
            const brand = getModelBrand(model.provider);
            const tags = getModelExperienceTags(model);
            const status = getModelExperienceStatus(model);
            const usageProfile = getModelUsageProfile(model);

            return (
            <article
              key={model.id}
              className="min-w-0 rounded-2xl border border-zinc-200 bg-zinc-50 p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900/40 [overflow-wrap:anywhere]"
            >
              <div className="flex flex-wrap items-start gap-3">
                <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${brand.className} text-base font-bold text-white shadow-sm ring-1 ring-zinc-200/70 dark:ring-zinc-800`}>
                  {brand.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={brand.image} alt={`${model.name} logo`} className="h-8 w-8 object-contain" />
                  ) : (
                    brand.mark
                  )}
                </span>
                <div className="min-w-0">
                  <h2 className="font-bold">{model.name}</h2>
                  <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">{model.id}</p>
                </div>
              </div>
              <p className="mt-4 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                {t(getModelBestFor(model))}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <span key={tag} className="rounded-full bg-white px-2 py-1 text-[11px] font-bold text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-950 dark:text-zinc-400 dark:ring-zinc-800">
                    {t(`modelTags.${tag}`)}
                  </span>
                ))}
              </div>
              <div className="mt-5 grid grid-cols-2 gap-3 max-[240px]:grid-cols-1">
                <div>
                  <p className="text-[11px] font-bold uppercase text-zinc-500 dark:text-zinc-400">{content.minimumPlan}</p>
                  <p className="mt-1 text-sm font-bold">{t(`modelTiers.${model.minimumPlan.toLowerCase()}`)}</p>
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase text-zinc-500 dark:text-zinc-400">{content.provider}</p>
                  <p className="mt-1 truncate text-sm font-bold capitalize">{model.provider}</p>
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase text-zinc-500 dark:text-zinc-400">{content.usageClass}</p>
                  <p className="mt-1 text-sm font-bold">
                    {t(`modelUsageClasses.${usageProfile.category.toLowerCase()}`)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase text-zinc-500 dark:text-zinc-400">{content.baseCharge}</p>
                  <CreditCostBadge
                    credits={usageProfile.credits}
                    size="md"
                    className="mt-1"
                    label={`${content.baseCharge}: ${usageProfile.credits} ${content.creditUnit}`}
                    testId="model-page-credit-cost"
                  />
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase text-zinc-500 dark:text-zinc-400">{content.status}</p>
                  <p className={`mt-1 text-sm font-bold ${status === "available" ? "text-emerald-700 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>{status === "available" ? content.enabled : status === "limited" ? content.limited : content.unavailable}</p>
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
