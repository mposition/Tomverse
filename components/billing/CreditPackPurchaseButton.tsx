"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Coins, X } from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import {
  getAnalyticsAttributionSnapshot,
  trackProductEvent,
} from "@/lib/productAnalyticsClient";

type Pack = {
  id: string;
  name: string;
  credits: number;
  priceCents: number;
  currency: string;
  validityDays: number;
};

const copy: Record<Language, { title: string; body: string; notice: string; buy: string; close: string; loading: string; expiry: string; error: string }> = {
  en: { title: "Buy additional credits", body: "One-time credits for extra work this month.", notice: "Additional credits increase usage only. They do not change model access, plan features, daily limits, or fair-use safeguards.", buy: "Buy", close: "Close", loading: "Loading…", expiry: "Valid for 12 months", error: "Credit packs could not be loaded." },
  ko: { title: "추가 크레딧 구매", body: "이번 달에만 작업량이 많을 때 사용하는 일회성 크레딧입니다.", notice: "추가 크레딧은 사용량만 늘립니다. 모델 접근 권한, 플랜 기능, 일일 제한 및 공정사용 안전장치는 변경되지 않습니다.", buy: "구매", close: "닫기", loading: "불러오는 중…", expiry: "12개월 유효", error: "크레딧 팩을 불러오지 못했습니다." },
  zh: { title: "购买额外积分", body: "用于本月额外工作的单次积分。", notice: "额外积分只增加使用量，不会更改模型权限、套餐功能、每日限制或公平使用保护。", buy: "购买", close: "关闭", loading: "加载中…", expiry: "有效期 12 个月", error: "无法加载积分包。" },
  fr: { title: "Acheter des crédits supplémentaires", body: "Crédits ponctuels pour un besoin supplémentaire ce mois-ci.", notice: "Les crédits augmentent uniquement l’usage. Ils ne modifient ni les modèles, ni les fonctions, ni les limites quotidiennes.", buy: "Acheter", close: "Fermer", loading: "Chargement…", expiry: "Valable 12 mois", error: "Impossible de charger les packs." },
  de: { title: "Zusätzliche Credits kaufen", body: "Einmalige Credits für zusätzlichen Bedarf in diesem Monat.", notice: "Zusätzliche Credits erhöhen nur die Nutzung. Modellzugriff, Funktionen, Tageslimits und Fair Use bleiben unverändert.", buy: "Kaufen", close: "Schließen", loading: "Laden…", expiry: "12 Monate gültig", error: "Credit-Pakete konnten nicht geladen werden." },
  es: { title: "Comprar créditos adicionales", body: "Créditos de un solo pago para trabajo adicional este mes.", notice: "Los créditos solo aumentan el uso. No cambian modelos, funciones, límites diarios ni uso justo.", buy: "Comprar", close: "Cerrar", loading: "Cargando…", expiry: "Válido 12 meses", error: "No se pudieron cargar los paquetes." },
  pt: { title: "Comprar créditos adicionais", body: "Créditos avulsos para trabalho extra neste mês.", notice: "Os créditos só aumentam o uso. Não alteram modelos, recursos, limites diários nem uso justo.", buy: "Comprar", close: "Fechar", loading: "Carregando…", expiry: "Válido por 12 meses", error: "Não foi possível carregar os pacotes." },
};

export function CreditPackPurchaseButton({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  const { lang } = useLanguage();
  const text = copy[lang];
  const [open, setOpen] = useState(false);
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [plan, setPlan] = useState<"Free" | "Pro" | "Max">("Free");
  const [error, setError] = useState("");
  const [buying, setBuying] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetch("/api/billing/credit-packs", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("load failed");
        return response.json();
      })
      .then((data) => {
        setPacks(Array.isArray(data.packs) ? data.packs : []);
        setPlan(data.plan === "Pro" || data.plan === "Max" ? data.plan : "Free");
      })
      .catch((requestError) => {
        if ((requestError as Error).name !== "AbortError") setError(text.error);
      });
    return () => controller.abort();
  }, [open, text.error]);

  const buy = async (packId: string) => {
    const pack = packs?.find((item) => item.id === packId);
    setBuying(packId);
    setError("");
    trackProductEvent("checkout_started", 0, {
      cta_location: "credit_pack_modal",
      plan_id: plan.toLowerCase() as "free" | "pro" | "max",
      value: (pack?.priceCents || 0) / 100,
      currency: "USD",
    });
    try {
      const analytics = getAnalyticsAttributionSnapshot();
      const response = await fetch("/api/billing/credit-packs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packId,
          language: lang,
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
                    {buying === pack.id ? text.loading : `${text.buy} · ${new Intl.NumberFormat(lang, { style: "currency", currency: pack.currency }).format(pack.priceCents / 100)}`}
                  </button>
                </article>
              ))}
            </div>
            {error && <p className="mt-3 text-sm font-semibold text-red-600 dark:text-red-300">{error}</p>}
            <p className="mt-5 rounded-2xl bg-amber-50 p-3 text-xs leading-5 text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">{text.notice}</p>
          </section>
        </div>,
        document.body
      )}
    </>
  );
}
