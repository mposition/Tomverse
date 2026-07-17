"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Coins, X } from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import {
  getAnalyticsAttributionSnapshot,
  trackProductEvent,
} from "@/lib/productAnalyticsClient";
import {
  normalizePurchaseAnalyticsTrigger,
  type PurchaseAnalyticsTrigger,
} from "@/lib/productAnalyticsShared";
import {
  billingMinorToMajor,
  formatBillingMinor,
  getBillingMarketQuery,
  getClientBillingMarket,
  type BillingCurrency,
  type BillingMarket,
} from "@/lib/billingMarkets";

type Pack = {
  id: string;
  name: string;
  credits: number;
  priceMinor: number;
  priceCents: number;
  currency: BillingCurrency;
  validityDays: number;
};

type PurchaseAnalyticsContext = {
  currentPlan: "free" | "pro" | "max";
  planCreditsRemaining: number;
  addonCreditsRemaining: number;
};

const copy: Record<Language, { title: string; body: string; notice: string; buy: string; close: string; loading: string; expiry: string; error: string }> = {
  en: { title: "Buy additional credits", body: "One-time credits for extra work this month.", notice: "Purchased credits remain usable after the plan’s daily credit guardrail is reached. They do not change model access, plan features, rate or concurrency limits, provider budgets, or fair-use safeguards.", buy: "Buy", close: "Close", loading: "Loading…", expiry: "Valid for 12 months", error: "Credit packs could not be loaded." },
  ko: { title: "추가 크레딧 구매", body: "이번 달에만 작업량이 많을 때 사용하는 일회성 크레딧입니다.", notice: "구매 크레딧은 플랜의 일일 크레딧 가드레일을 넘어 사용할 수 있습니다. 모델 접근 권한, 플랜 기능, 분당·동시 요청 제한, 공급자 예산 및 공정사용 안전장치는 변경되지 않습니다.", buy: "구매", close: "닫기", loading: "불러오는 중…", expiry: "12개월 유효", error: "크레딧 팩을 불러오지 못했습니다." },
  zh: { title: "购买额外积分", body: "用于本月额外工作的单次积分。", notice: "达到套餐每日积分保护额度后，已购买积分仍可使用。模型权限、套餐功能、请求频率与并发限制、供应商预算及公平使用保护不会改变。", buy: "购买", close: "关闭", loading: "加载中…", expiry: "有效期 12 个月", error: "无法加载积分包。" },
  fr: { title: "Acheter des crédits supplémentaires", body: "Crédits ponctuels pour un besoin supplémentaire ce mois-ci.", notice: "Les crédits achetés restent utilisables après la limite quotidienne du forfait. Ils ne modifient ni l’accès aux modèles, ni les fonctions, ni les limites de fréquence et de concurrence, ni les budgets fournisseur ou les protections d’usage équitable.", buy: "Acheter", close: "Fermer", loading: "Chargement…", expiry: "Valable 12 mois", error: "Impossible de charger les packs." },
  de: { title: "Zusätzliche Credits kaufen", body: "Einmalige Credits für zusätzlichen Bedarf in diesem Monat.", notice: "Gekaufte Credits bleiben nach Erreichen des täglichen Planlimits nutzbar. Modellzugriff, Planfunktionen, Raten- und Parallelitätslimits, Anbieterbudgets und Fair-Use-Schutz bleiben unverändert.", buy: "Kaufen", close: "Schließen", loading: "Laden…", expiry: "12 Monate gültig", error: "Credit-Pakete konnten nicht geladen werden." },
  es: { title: "Comprar créditos adicionales", body: "Créditos de un solo pago para trabajo adicional este mes.", notice: "Los créditos comprados siguen disponibles después del límite diario del plan. No cambian el acceso a modelos, las funciones, los límites de frecuencia o concurrencia, los presupuestos de proveedores ni las protecciones de uso justo.", buy: "Comprar", close: "Cerrar", loading: "Cargando…", expiry: "Válido 12 meses", error: "No se pudieron cargar los paquetes." },
  pt: { title: "Comprar créditos adicionais", body: "Créditos avulsos para trabalho extra neste mês.", notice: "Créditos comprados continuam disponíveis após o limite diário do plano. Eles não alteram acesso a modelos, recursos, limites de taxa ou simultaneidade, orçamentos de provedores nem proteções de uso justo.", buy: "Comprar", close: "Fechar", loading: "Carregando…", expiry: "Válido por 12 meses", error: "Não foi possível carregar os pacotes." },
};

export function CreditPackPurchaseButton({
  children,
  className,
  trigger = "proactive",
}: {
  children?: ReactNode;
  className?: string;
  trigger?: PurchaseAnalyticsTrigger;
}) {
  const { lang } = useLanguage();
  const text = copy[lang];
  const [open, setOpen] = useState(false);
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [plan, setPlan] = useState<"Free" | "Pro" | "Max">("Free");
  const [debtCredits, setDebtCredits] = useState(0);
  const [billingMarket, setBillingMarket] = useState<BillingMarket | null>(null);
  const [purchaseAnalyticsContext, setPurchaseAnalyticsContext] =
    useState<PurchaseAnalyticsContext | null>(null);
  const [error, setError] = useState("");
  const [buying, setBuying] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetch(`/api/billing/credit-packs?${getBillingMarketQuery()}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("load failed");
        return response.json();
      })
      .then((data) => {
        setPacks(Array.isArray(data.packs) ? data.packs : []);
        setPlan(data.plan === "Pro" || data.plan === "Max" ? data.plan : "Free");
        setBillingMarket(data.market || getClientBillingMarket());
        setDebtCredits(Math.max(0, Number(data.creditDebt?.credits) || 0));
        setPurchaseAnalyticsContext({
          currentPlan:
            data.analyticsContext?.currentPlan === "max"
              ? "max"
              : data.analyticsContext?.currentPlan === "pro"
                ? "pro"
                : "free",
          planCreditsRemaining: Math.max(
            0,
            Number(data.analyticsContext?.planCreditsRemaining) || 0
          ),
          addonCreditsRemaining: Math.max(
            0,
            Number(data.analyticsContext?.addonCreditsRemaining) || 0
          ),
        });
      })
      .catch((requestError) => {
        if ((requestError as Error).name !== "AbortError") setError(text.error);
      });
    return () => controller.abort();
  }, [open, text.error]);

  const buy = async (packId: string) => {
    const pack = packs?.find((item) => item.id === packId);
    if (!pack) return;
    setBuying(packId);
    setError("");
    const purchaseTrigger = normalizePurchaseAnalyticsTrigger(trigger);
    const analyticsContext = purchaseAnalyticsContext || {
      currentPlan: plan.toLowerCase() as "free" | "pro" | "max",
      planCreditsRemaining: 0,
      addonCreditsRemaining: 0,
    };
    trackProductEvent("checkout_started", 0, {
      cta_location: "credit_pack_modal",
      plan_id: plan.toLowerCase() as "free" | "pro" | "max",
      purchase_type: "credit_pack",
      product_id: pack.id,
      pack_id: pack.id,
      credits_purchased: pack.credits,
      current_plan: analyticsContext.currentPlan,
      trigger: purchaseTrigger,
      plan_credits_remaining: analyticsContext.planCreditsRemaining,
      addon_credits_remaining: analyticsContext.addonCreditsRemaining,
      value: billingMinorToMajor(pack.priceMinor, pack.currency),
      currency: pack.currency,
    });
    try {
      const analytics = getAnalyticsAttributionSnapshot();
      const market = billingMarket || getClientBillingMarket();
      const response = await fetch("/api/billing/credit-packs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packId,
          language: lang,
          currency: pack.currency,
          country: market.country,
          trigger: purchaseTrigger,
          ...(analytics ? { analytics } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.url) throw new Error(data.error || "checkout failed");
      window.location.assign(data.url);
    } catch {
      trackProductEvent("checkout_failed", 0, {
        failure_stage: "checkout_session",
        error_code: "checkout_request_failed",
      });
      setError(text.error);
      setBuying(null);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setPacks(null);
          setPurchaseAnalyticsContext(null);
          setBillingMarket(null);
          setError("");
          setOpen(true);
        }}
        className={className || "font-black text-amber-900 underline underline-offset-2 dark:text-amber-100"}
      >
        {children || text.title}
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/65 p-3 backdrop-blur-sm sm:items-center" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section role="dialog" aria-modal="true" aria-labelledby="credit-pack-title" className="max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-3xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="credit-pack-title" className="flex items-center gap-2 text-xl font-black text-zinc-950 dark:text-white"><Coins className="h-5 w-5 text-emerald-500" />{text.title}</h2>
                <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{text.body}</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label={text.close} className="rounded-xl p-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900"><X className="h-5 w-5" /></button>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {packs === null && !error && <p className="text-sm text-zinc-500">{text.loading}</p>}
              {packs?.map((pack) => (
                <article key={pack.id} className="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
                  <p className="text-sm font-black text-zinc-950 dark:text-white">{pack.name}</p>
                  <p className="mt-2 text-2xl font-black text-zinc-950 dark:text-white">{pack.credits.toLocaleString(lang)} <span className="text-sm text-zinc-500">credits</span></p>
                  <p className="mt-1 text-xs text-zinc-500">{text.expiry}</p>
                  <button type="button" disabled={Boolean(buying)} onClick={() => void buy(pack.id)} className="mt-4 w-full rounded-xl bg-emerald-600 px-3 py-2.5 text-sm font-black text-white hover:bg-emerald-500 disabled:opacity-60">
                    {buying === pack.id
                      ? text.loading
                      : `${text.buy} · ${formatBillingMinor(pack.priceMinor, pack.currency, lang)}`}
                  </button>
                </article>
              ))}
            </div>
            {error && <p className="mt-3 text-sm font-semibold text-red-600 dark:text-red-300">{error}</p>}
            {debtCredits > 0 && (
              <p className="mt-3 rounded-2xl border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100">
                {lang === "ko"
                  ? `미회수 크레딧 ${debtCredits.toLocaleString(lang)}개가 있습니다. 새로 구매한 크레딧은 이 잔액에 먼저 상계되며, 남은 크레딧만 사용할 수 있습니다.`
                  : `${debtCredits.toLocaleString(lang)} unrecovered credits are outstanding. New credits are applied to this balance first, and only the remainder becomes available.`}
              </p>
            )}
            <p className="mt-5 rounded-2xl bg-amber-50 p-3 text-xs leading-5 text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">{text.notice}</p>
          </section>
        </div>,
        document.body
      )}
    </>
  );
}
