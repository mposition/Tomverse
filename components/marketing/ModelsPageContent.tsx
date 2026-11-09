"use client";

import Link from "next/link";
import { useState } from "react";
import { Activity, ExternalLink } from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import { ModelInputCreditGuide } from "./ModelInputCreditGuide";
import { canUseModelWithPlan, getModelUsageProfile, modelSupportsImageInput, type ModelTier } from "@/lib/models";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { getModelBrand } from "@/lib/modelBranding";
import { getModelBestFor, getModelExperienceStatus, getModelExperienceTags } from "@/lib/modelExperience";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";
import { statusLinkLabel, statusNewTabCopy } from "./statusLinkCopy";

const copy = {
  en: {
    eyebrow: "Models",
    title: "Find a model for your question.",
    description: "Compare access plans, base credits, image input and catalog context limits. These are model-specific catalog facts, not a ranking of task performance; a higher credit cost does not prove a stronger answer. Check current availability in the app’s model selector.",
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
    mobileDescription: "Chat과 Review의 모델, 기본 크레딧과 이용 플랜을 비교하세요.",
    mobileCreditNote: "모델별 ‘짧은 요청의 기본 크레딧’ 숫자로 기본 비용을 비교하세요.",
    mobileUsageDetails: "크레딧·이용 안내 자세히 보기",
    provider: "공급자",
    usageClass: "크레딧 사용 등급",
    baseCharge: "짧은 요청의 기본 크레딧",
    creditUnit: "크레딧",
    usageNote: "비용은 ‘짧은 요청의 기본 크레딧’ 숫자로 비교하세요. 숫자가 클수록 같은 짧은 요청의 기본 비용이 높으며, 요금제나 성능 순위가 아닙니다. 긴 대화와 파일은 입력 크기에 따라 기본 크레딧의 1.5배, 2배 또는 3배를 사용할 수 있습니다. ‘추론’은 모델 기능 태그이며 비용 단계가 아닙니다. 추천 활용과 태그는 비교를 돕는 참고입니다. EU는 공급자 기반 지역을 뜻하며 데이터 저장 위치를 보장하지 않습니다. 게스트 이용 모델에도 사용 한도가 적용됩니다.",
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
  "zh-Hant": {
    eyebrow: "模型",
    title: "找到適合問題的模型。",
    description: "比較建議用途、基礎點數與使用所需方案。了解 Tomverse Chat 與 Review 中可選的模型，並在應用程式的模型選擇器中再次確認目前可用狀況與用量。",
    provider: "供應商",
    usageClass: "點數消耗等級",
    baseCharge: "短請求基礎點數",
    creditUnit: "點數",
    usageNote: "點數等級與訂閱方案不同。長對話和檔案可能依輸入大小消耗基礎點數的 1.5、2 或 3 倍。建議用途與標籤僅供比較參考，不代表效能排名。EU 指供應商所在地，不保證資料儲存位置。訪客可用的模型也受用量限制。",
    status: "狀態",
    enabled: "可用",
    liveStatus: "查看即時服務狀態",
    liveStatusDescription: "查看目前供應商的可用性及影響服務的事件。",

    limited: "可用性受限",
    unavailable: "暫不可用",
    minimumPlan: "使用所需方案",
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

const filterCopy = {
  en: { search: "Search model name or ID", allProviders: "All providers", plan: "Available with plan", allPlans: "All plans", results: "Models shown", empty: "No models match these filters.", clear: "Clear filters" },
  ko: { search: "모델명 또는 ID 검색", allProviders: "모든 공급자", plan: "이용할 플랜", allPlans: "모든 플랜", results: "표시된 모델", empty: "조건에 맞는 모델이 없습니다.", clear: "필터 초기화" },
  zh: { search: "搜索模型名称或 ID", allProviders: "所有供应商", plan: "可用套餐", allPlans: "所有套餐", results: "显示的模型", empty: "没有符合筛选条件的模型。", clear: "清除筛选" },
  "zh-Hant": { search: "搜尋模型名稱或 ID", allProviders: "所有供應商", plan: "可用方案", allPlans: "所有方案", results: "顯示的模型", empty: "沒有符合篩選條件的模型。", clear: "清除篩選" },
  fr: { search: "Rechercher un nom ou ID de modèle", allProviders: "Tous les fournisseurs", plan: "Disponible avec l’offre", allPlans: "Toutes les offres", results: "Modèles affichés", empty: "Aucun modèle ne correspond à ces filtres.", clear: "Effacer les filtres" },
  de: { search: "Modellname oder ID suchen", allProviders: "Alle Anbieter", plan: "Verfügbar im Tarif", allPlans: "Alle Tarife", results: "Angezeigte Modelle", empty: "Keine Modelle entsprechen diesen Filtern.", clear: "Filter zurücksetzen" },
  es: { search: "Buscar nombre o ID de modelo", allProviders: "Todos los proveedores", plan: "Disponible con el plan", allPlans: "Todos los planes", results: "Modelos mostrados", empty: "Ningún modelo coincide con estos filtros.", clear: "Borrar filtros" },
  pt: { search: "Buscar nome ou ID de modelo", allProviders: "Todos os provedores", plan: "Disponível no plano", allPlans: "Todos os planos", results: "Modelos exibidos", empty: "Nenhum modelo corresponde a estes filtros.", clear: "Limpar filtros" },
} satisfies Record<Language, Record<string, string>>;

export function ModelsPageContent() {
  const { enabledModels: ENABLED_MODELS } = useModelCatalog();
  const { lang, t } = useLanguage();
  const content = copy[lang];
  const filters = filterCopy[lang];
  const [query, setQuery] = useState("");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [provider, setProvider] = useState("all");
  const [plan, setPlan] = useState<ModelTier | "Guest" | "all">("all");
  const providers = [...new Set(ENABLED_MODELS.map((model) => model.provider))].sort();
  const search = query.trim().toLowerCase();
  const filteredModels = ENABLED_MODELS.filter((model) =>
    (provider === "all" || model.provider === provider) &&
    (plan === "all" || canUseModelWithPlan(plan, model)) &&
    (!search || model.name.toLowerCase().includes(search) || model.id.toLowerCase().includes(search))
  );

  return (
    <main className="min-h-screen bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader maxWidth="max-w-6xl" />

      <section className="mx-auto max-w-6xl px-4 py-8 [overflow-wrap:anywhere] sm:px-6 sm:py-14 lg:py-20">
        <div className="max-w-3xl">
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">{content.eyebrow}</p>
          <h1 className="mt-4 text-3xl font-black leading-tight sm:text-6xl">{content.title}</h1>
          <p className={`mt-5 text-lg leading-8 text-zinc-600 dark:text-zinc-300 ${lang === "ko" ? "hidden sm:block" : ""}`}>{content.description}</p>
          {lang === "ko" ? (
            <div className="mt-4 space-y-3 sm:hidden">
              <p className="text-base leading-7 text-zinc-600 dark:text-zinc-300">{copy.ko.mobileDescription}</p>
              <p className="text-sm font-semibold leading-6 text-blue-800 dark:text-blue-200">{copy.ko.mobileCreditNote}</p>
              <details data-testid="models-mobile-usage-details" className="rounded-xl border border-blue-500/20 bg-blue-500/10 px-3 text-sm leading-6 text-blue-800 dark:text-blue-200">
                <summary className="min-h-11 cursor-pointer py-2.5 font-bold">{copy.ko.mobileUsageDetails}</summary>
                <p className="pb-3">{content.usageNote}</p>
              </details>
            </div>
          ) : null}
          <p className={`mt-5 rounded-2xl border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-sm font-semibold leading-6 text-blue-800 dark:text-blue-200 ${lang === "ko" ? "hidden sm:block" : ""}`}>
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
            className="mt-5 inline-flex max-w-full items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-left transition hover:bg-emerald-500/15 sm:mt-7 [overflow-wrap:anywhere] max-[240px]:flex-col max-[240px]:items-start"
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

        {lang === "ko" ? (
          <button type="button" data-testid="models-mobile-filters-toggle" aria-expanded={mobileFiltersOpen}
            aria-controls="models-catalog-filters" onClick={() => setMobileFiltersOpen((open) => !open)}
            className="mt-5 flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-zinc-300 px-3 py-2 text-left text-sm font-bold dark:border-zinc-700 sm:hidden">
            {filters.search}<span aria-hidden="true">{mobileFiltersOpen ? "−" : "+"}</span>
          </button>
        ) : null}
        <div id="models-catalog-filters" role="search" aria-label={filters.search}
          className={`mt-5 min-w-0 gap-4 sm:mt-10 sm:grid-cols-3 ${lang === "ko" && !mobileFiltersOpen ? "hidden sm:grid" : "grid"}`}>
          <label className="min-w-0 text-sm font-bold">
            {filters.search}
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} className="mt-2 min-h-11 w-full min-w-0 rounded-xl border border-zinc-300 bg-white px-3 py-2 font-normal focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-zinc-700 dark:bg-zinc-900" />
          </label>
          <label className="min-w-0 text-sm font-bold">
            {content.provider}
            <select value={provider} onChange={(event) => setProvider(event.target.value)} className="mt-2 min-h-11 w-full min-w-0 rounded-xl border border-zinc-300 bg-white px-3 py-2 font-normal focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-zinc-700 dark:bg-zinc-900">
              <option value="all">{filters.allProviders}</option>
              {providers.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="min-w-0 text-sm font-bold">
            {filters.plan}
            <select value={plan} onChange={(event) => setPlan(event.target.value as typeof plan)} className="mt-2 min-h-11 w-full min-w-0 rounded-xl border border-zinc-300 bg-white px-3 py-2 font-normal focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-zinc-700 dark:bg-zinc-900">
              <option value="all">{filters.allPlans}</option>
              {(["Guest", "Free", "Pro", "Max"] as const).map((value) => <option key={value} value={value}>{t(`modelTiers.${value.toLowerCase()}`)}</option>)}
            </select>
          </label>
          <p role="status" aria-atomic="true" className="self-center text-sm sm:col-span-2">{filters.results}: {filteredModels.length} / {ENABLED_MODELS.length}</p>
          <button type="button" onClick={() => { setQuery(""); setProvider("all"); setPlan("all"); }} className="min-h-11 rounded-xl border border-zinc-300 px-3 py-2 text-sm font-bold focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-zinc-700">{filters.clear}</button>
        </div>
        {filteredModels.length === 0 ? <p className="mt-8 text-sm">{filters.empty}</p> : null}
        <div className="mt-5 grid grid-cols-1 gap-4 sm:mt-12 sm:grid-cols-2 lg:grid-cols-3">
          {filteredModels.map((model) => {
            const brand = getModelBrand(model.provider);
            const tags = getModelExperienceTags(model).filter((tag) => lang !== "en" || tag === "reasoning" || tag === "free");
            const status = getModelExperienceStatus(model);
            const usageProfile = getModelUsageProfile(model);

            return (
            <article
              key={model.id}
              data-model-id={model.id}
              className="min-w-0 rounded-2xl border border-zinc-200 bg-zinc-50 p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900/40 [overflow-wrap:anywhere]"
            >
              <div className="flex items-start gap-3 max-[240px]:flex-wrap">
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
                  <p className="break-words text-sm font-semibold leading-5 text-zinc-600 dark:text-zinc-300">{model.id}</p>
                </div>
              </div>
              <p data-testid={lang === "en" ? "model-selection-criteria" : undefined} className="mt-4 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                {lang === "en" ? `Access from: ${t(`modelTiers.${model.minimumPlan.toLowerCase()}`)} · Short request: ${usageProfile.credits} credits · Image input: ${modelSupportsImageInput(model) ? "supported" : "not supported"} · Catalog context maximum: ${model.contextWindowTokens ? `${model.contextWindowTokens.toLocaleString("en-US")} tokens` : "not listed"}` : t(getModelBestFor(model))}
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
                  <p className="break-words text-sm font-bold uppercase leading-5 text-zinc-600 dark:text-zinc-300">{content.minimumPlan}</p>
                  <p className="mt-1 text-sm font-bold">{t(`modelTiers.${model.minimumPlan.toLowerCase()}`)}</p>
                </div>
                <div>
                  <p className="break-words text-sm font-bold uppercase leading-5 text-zinc-600 dark:text-zinc-300">{content.provider}</p>
                  <p className="mt-1 truncate text-sm font-bold capitalize">{model.provider}</p>
                </div>
                {lang !== "ko" ? <div>
                  <p className="break-words text-sm font-bold uppercase leading-5 text-zinc-600 dark:text-zinc-300">{content.usageClass}</p>
                  <p className="mt-1 text-sm font-bold">
                    {t(`modelUsageClasses.${usageProfile.category.toLowerCase()}`)}
                  </p>
                </div> : null}
                <div>
                  <p className="break-words text-sm font-bold uppercase leading-5 text-zinc-600 dark:text-zinc-300">{content.baseCharge}</p>
                  <CreditCostBadge
                    credits={usageProfile.credits}
                    size="md"
                    className="mt-1"
                    label={`${content.baseCharge}: ${usageProfile.credits} ${content.creditUnit}`}
                    testId="model-page-credit-cost"
                  />
                  {lang === "en" && <a href="#model-input-credit-guide" className="mt-1 inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 underline underline-offset-4 dark:text-blue-300">Input size and credit multipliers</a>}
                </div>
                <div>
                  <p className="break-words text-sm font-bold uppercase leading-5 text-zinc-600 dark:text-zinc-300">{content.status}</p>
                  <p className={`mt-1 text-sm font-bold ${status === "available" ? "text-emerald-700 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>{status === "available" ? content.enabled : status === "limited" ? content.limited : content.unavailable}</p>
                </div>
              </div>
            </article>
            );
          })}
        </div>
        {lang === "en" && <ModelInputCreditGuide />}
      </section>
      <MarketingFooter maxWidth="max-w-6xl" />
    </main>
  );
}
