"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
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
import {
  buildPurchaseSignInHref,
  classifyBillingError,
  isRetryableBillingError,
  normalizeCreditPackId,
  requiresReauthentication,
  requiresSupport,
  type BillingErrorCode,
} from "@/lib/purchaseIntent";
import { billingErrorMessage, purchaseCtaCopy } from "./purchaseCopy";

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

/** Analytics error codes are the lower-cased form of the shared billing codes. */
const analyticsErrorCode = (code: BillingErrorCode) =>
  code.toLowerCase() as Lowercase<BillingErrorCode>;

const copy: Record<Language, { title: string; body: string; notice: string; buy: string; close: string; loading: string; expiry: string; error: string; selected: string }> = {
  en: { title: "Buy additional credits", body: "One-time credits for extra work this month.", notice: "Purchased credits remain usable after the plan’s daily credit guardrail is reached. They do not change model access, plan features, rate or concurrency limits, provider budgets, or fair-use safeguards.", buy: "Buy", close: "Close", loading: "Loading…", expiry: "Valid for 12 months", error: "Credit packs could not be loaded.", selected: "Selected" },
  ko: { title: "추가 크레딧 구매", body: "이번 달에만 작업량이 많을 때 사용하는 일회성 크레딧입니다.", notice: "구매 크레딧은 플랜의 일일 크레딧 가드레일을 넘어 사용할 수 있습니다. 모델 접근 권한, 플랜 기능, 분당·동시 요청 제한, 공급자 예산 및 공정사용 안전장치는 변경되지 않습니다.", buy: "구매", close: "닫기", loading: "불러오는 중…", expiry: "12개월 유효", error: "크레딧 팩을 불러오지 못했습니다.", selected: "선택됨" },
  zh: { title: "购买额外积分", body: "用于本月额外工作的单次积分。", notice: "达到套餐每日积分保护额度后，已购买积分仍可使用。模型权限、套餐功能、请求频率与并发限制、供应商预算及公平使用保护不会改变。", buy: "购买", close: "关闭", loading: "加载中…", expiry: "有效期 12 个月", error: "无法加载积分包。", selected: "已选择" },
  fr: { title: "Acheter des crédits supplémentaires", body: "Crédits ponctuels pour un besoin supplémentaire ce mois-ci.", notice: "Les crédits achetés restent utilisables après la limite quotidienne du forfait. Ils ne modifient ni l’accès aux modèles, ni les fonctions, ni les limites de fréquence et de concurrence, ni les budgets fournisseur ou les protections d’usage équitable.", buy: "Acheter", close: "Fermer", loading: "Chargement…", expiry: "Valable 12 mois", error: "Impossible de charger les packs.", selected: "Sélectionné" },
  de: { title: "Zusätzliche Credits kaufen", body: "Einmalige Credits für zusätzlichen Bedarf in diesem Monat.", notice: "Gekaufte Credits bleiben nach Erreichen des täglichen Planlimits nutzbar. Modellzugriff, Planfunktionen, Raten- und Parallelitätslimits, Anbieterbudgets und Fair-Use-Schutz bleiben unverändert.", buy: "Kaufen", close: "Schließen", loading: "Laden…", expiry: "12 Monate gültig", error: "Credit-Pakete konnten nicht geladen werden.", selected: "Ausgewählt" },
  es: { title: "Comprar créditos adicionales", body: "Créditos de un solo pago para trabajo adicional este mes.", notice: "Los créditos comprados siguen disponibles después del límite diario del plan. No cambian el acceso a modelos, las funciones, los límites de frecuencia o concurrencia, los presupuestos de proveedores ni las protecciones de uso justo.", buy: "Comprar", close: "Cerrar", loading: "Cargando…", expiry: "Válido 12 meses", error: "No se pudieron cargar los paquetes.", selected: "Seleccionado" },
  pt: { title: "Comprar créditos adicionais", body: "Créditos avulsos para trabalho extra neste mês.", notice: "Créditos comprados continuam disponíveis após o limite diário do plano. Eles não alteram acesso a modelos, recursos, limites de taxa ou simultaneidade, orçamentos de provedores nem proteções de uso justo.", buy: "Comprar", close: "Fechar", loading: "Carregando…", expiry: "Válido por 12 meses", error: "Não foi possível carregar os pacotes.", selected: "Selecionado" },
};

const creditUnit: Record<Language, string> = {
  en: "credits",
  ko: "크레딧",
  zh: "积分",
  fr: "crédits",
  de: "Credits",
  es: "créditos",
  pt: "créditos",
};

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function CreditPackPurchaseButton({
  children,
  className,
  trigger = "proactive",
  initialPackId = null,
  returnTo,
  ctaLocation = "credit_pack_modal",
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
  onAuthenticationRequired,
  testId,
}: {
  children?: ReactNode;
  className?: string;
  trigger?: PurchaseAnalyticsTrigger;
  /**
   * Pre-selects the pack the visitor actually clicked, so the modal opens on
   * their choice instead of making them find it again in a three-card grid.
   */
  initialPackId?: string | null;
  /**
   * Where Stripe should send them back to. Only ever a proposal: the server
   * re-validates it against its own allowlist before it reaches `success_url`.
   */
  returnTo?: string;
  ctaLocation?: string;
  /** Controlled mode. Omit both to keep the original self-contained button. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Renders the modal only -- for callers that own their own trigger. */
  hideTrigger?: boolean;
  /**
   * Called when the account turns out not to be signed in (or no longer is).
   * The caller decides how to recover; the modal always shows its own
   * re-authentication CTA regardless, so a caller that ignores this is not
   * left with a dead end.
   */
  onAuthenticationRequired?: (code: BillingErrorCode) => void;
  testId?: string;
}) {
  const { lang } = useLanguage();
  const text = copy[lang];
  const ctaText = purchaseCtaCopy[lang] || purchaseCtaCopy.en;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [plan, setPlan] = useState<"Free" | "Pro" | "Max">("Free");
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const [debtCredits, setDebtCredits] = useState(0);
  const [billingMarket, setBillingMarket] = useState<BillingMarket | null>(null);
  const [purchaseAnalyticsContext, setPurchaseAnalyticsContext] =
    useState<PurchaseAnalyticsContext | null>(null);
  const [errorCode, setErrorCode] = useState<BillingErrorCode | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // A React state update is asynchronous, so `disabled` alone still lets two
  // clicks land inside one frame -- and a browser's back button restores the
  // page with `buying` cleared while the first checkout session is still live.
  // This ref is what actually makes "one click, one Stripe session" true.
  const checkoutInFlightRef = useRef(false);
  const checkoutStartedForRef = useRef<string | null>(null);
  const selectionTrackedRef = useRef<string | null>(null);

  const setOpen = useCallback(
    (next: boolean) => {
      if (onOpenChange) onOpenChange(next);
      if (controlledOpen === undefined) setUncontrolledOpen(next);
    },
    [controlledOpen, onOpenChange]
  );

  const resetPurchaseState = useCallback(() => {
    setPacks(null);
    setPurchaseAnalyticsContext(null);
    setBillingMarket(null);
    setErrorCode(null);
    setBuying(null);
    checkoutInFlightRef.current = false;
    checkoutStartedForRef.current = null;
  }, []);

  // The pack the caller asked for wins until the visitor picks another one.
  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => setSelectedPackId(normalizeCreditPackId(initialPackId)));
  }, [initialPackId, open]);

  useEffect(() => {
    if (!open) {
      // A controlled caller can reopen this modal without going through the
      // trigger, so the teardown -- not the trigger's click handler -- is what
      // guarantees the next open starts from a clean, freshly fetched state.
      checkoutInFlightRef.current = false;
      checkoutStartedForRef.current = null;
      selectionTrackedRef.current = null;
      queueMicrotask(() => {
        setPacks(null);
        setErrorCode(null);
        setBuying(null);
      });
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    void fetch(`/api/billing/credit-packs?${getBillingMarketQuery()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          // The caller only renders this modal for a signed-in account, so a
          // 401 here is an expired session rather than an anonymous visitor.
          // Reporting it as "packs could not be loaded" is what turned a
          // recoverable sign-in into a dead end.
          const code = classifyBillingError({
            status: response.status,
            code: (data as { code?: unknown } | null)?.code,
            wasAuthenticated: true,
          });
          throw Object.assign(new Error("credit pack load failed"), { code });
        }
        return data;
      })
      .then((data) => {
        if (cancelled || !data) return;
        const loadedPacks: Pack[] = Array.isArray(data.packs) ? data.packs : [];
        setPacks(loadedPacks);
        setPlan(data.plan === "Pro" || data.plan === "Max" ? data.plan : "Free");
        setBillingMarket(data.market || getClientBillingMarket());
        setDebtCredits(Math.max(0, Number(data.creditDebt?.credits) || 0));
        // The pack that was clicked on the pricing page can turn out not to
        // be sold to this account's plan -- the public catalogue lists all
        // three. Dropping the selection silently left the visitor looking at a
        // modal that had quietly changed its mind about what they picked.
        const preferred = normalizeCreditPackId(initialPackId);
        if (preferred && !loadedPacks.some((pack) => pack.id === preferred)) {
          setErrorCode("PACK_NOT_AVAILABLE_FOR_PLAN");
        }
        setSelectedPackId((current) =>
          current && loadedPacks.some((pack) => pack.id === current)
            ? current
            : null
        );
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
        if (cancelled || (requestError as Error).name === "AbortError") return;
        const code =
          ((requestError as { code?: BillingErrorCode }).code as
            | BillingErrorCode
            | undefined) ||
          classifyBillingError({
            networkFailure: requestError instanceof TypeError,
          });
        setErrorCode(code);
        trackProductEvent("checkout_failed", 0, {
          cta_location: ctaLocation,
          failure_stage: "credit_pack_load",
          error_code: analyticsErrorCode(code),
        });
        if (requiresReauthentication(code)) {
          trackProductEvent("authentication_required", 0, {
            cta_location: ctaLocation,
            purchase_type: "credit_pack",
            authentication_state: "unauthenticated",
            error_code: analyticsErrorCode(code),
          });
          onAuthenticationRequired?.(code);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [ctaLocation, initialPackId, loadAttempt, onAuthenticationRequired, open]);

  // Modal semantics: Escape closes, Tab cycles inside, focus returns to
  // whatever opened it. Without the trap a keyboard visitor tabbed straight
  // out of the dialog into the pricing page behind it and lost the purchase.
  //
  // Two effects, for the reason `useModalDialog` is also two: this one places
  // focus on open and returns it on teardown, so anything in its dependency
  // list that changes on a caller render moves focus twice for free. `setOpen`
  // reads like a state setter and is not one -- it is
  // `useCallback(..., [controlledOpen, onOpenChange])`, so a caller wiring
  // `onOpenChange` inline would make it new on every render. This dialog opens
  // inside `UsageLimitModal`, which sits inside `ChatInput`, and it is the
  // dialog whose "first button is focused" assertion flipped the nightly on
  // identical commits (runs 6 and 7 on 18d1e891). No caller passes
  // `onOpenChange` today, which made it safe by accident rather than by
  // construction.
  useEffect(() => {
    if (!open) return;
    if (!returnFocusRef.current?.isConnected) {
      returnFocusRef.current =
        (document.activeElement as HTMLElement | null) || triggerRef.current;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      const returnTarget = returnFocusRef.current;
      returnFocusRef.current = null;
      requestAnimationFrame(() => {
        if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
      });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const modalDialogs = Array.from(
        document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')
      );
      if (modalDialogs.at(-1) !== dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((node) => node.offsetParent !== null || node === document.activeElement);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, setOpen]);

  const signInHref = useMemo(
    () => buildPurchaseSignInHref(returnTo || "/pricing"),
    [returnTo]
  );

  const analyticsContext = useMemo(
    () =>
      purchaseAnalyticsContext || {
        currentPlan: plan.toLowerCase() as "free" | "pro" | "max",
        planCreditsRemaining: 0,
        addonCreditsRemaining: 0,
      },
    [plan, purchaseAnalyticsContext]
  );

  // `credit_pack_selected` is emitted from the selection itself, not from the
  // click that caused it. A pack chosen on a pricing card arrives here as
  // `initialPackId` and is already selected when the modal opens -- tracking
  // it in the click handler meant the funnel recorded a checkout with no
  // selection before it, which reads as a step nobody ever completed.
  useEffect(() => {
    if (!open || !packs || !selectedPackId) return;
    if (selectionTrackedRef.current === selectedPackId) return;
    selectionTrackedRef.current = selectedPackId;
    const pack = packs.find((item) => item.id === selectedPackId);
    trackProductEvent("credit_pack_selected", 0, {
      cta_location: ctaLocation,
      purchase_type: "credit_pack",
      pack_id: selectedPackId,
      product_id: selectedPackId,
      authentication_state: "authenticated",
      current_plan: analyticsContext.currentPlan,
      trigger: normalizePurchaseAnalyticsTrigger(trigger),
      plan_credits_remaining: analyticsContext.planCreditsRemaining,
      addon_credits_remaining: analyticsContext.addonCreditsRemaining,
      ...(pack ? { credits_purchased: pack.credits } : {}),
    });
  }, [
    analyticsContext,
    ctaLocation,
    open,
    packs,
    selectedPackId,
    trigger,
  ]);

  const buy = async (packId: string) => {
    const pack = packs?.find((item) => item.id === packId);
    if (!pack) return;
    // Guard first, state second: two clicks in one frame both see `buying`
    // as null, but only the first sees the ref as false.
    if (checkoutInFlightRef.current) return;
    checkoutInFlightRef.current = true;
    setBuying(packId);
    setErrorCode(null);
    const purchaseTrigger = normalizePurchaseAnalyticsTrigger(trigger);
    // One `checkout_started` per pack per modal session. A retry after a
    // failure re-arms it; a double click does not.
    if (checkoutStartedForRef.current !== packId) {
      checkoutStartedForRef.current = packId;
      trackProductEvent("checkout_started", 0, {
        cta_location: ctaLocation,
        plan_id: plan.toLowerCase() as "free" | "pro" | "max",
        purchase_type: "credit_pack",
        product_id: pack.id,
        pack_id: pack.id,
        credits_purchased: pack.credits,
        current_plan: analyticsContext.currentPlan,
        authentication_state: "authenticated",
        trigger: purchaseTrigger,
        plan_credits_remaining: analyticsContext.planCreditsRemaining,
        addon_credits_remaining: analyticsContext.addonCreditsRemaining,
        value: billingMinorToMajor(pack.priceMinor, pack.currency),
        currency: pack.currency,
      });
    }
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
          ...(returnTo ? { returnTo } : {}),
          ...(analytics ? { analytics } : {}),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.url) {
        const code = classifyBillingError({
          status: response.status,
          code: (data as { code?: unknown } | null)?.code,
          wasAuthenticated: true,
        });
        throw Object.assign(new Error("checkout failed"), { code });
      }
      // Deliberately not clearing the in-flight guard: the document is being
      // replaced. Clearing it here is what would let a second click during the
      // navigation create a second Stripe session.
      window.location.assign(data.url);
    } catch (requestError) {
      const code =
        ((requestError as { code?: BillingErrorCode }).code as
          | BillingErrorCode
          | undefined) ||
        classifyBillingError({
          networkFailure: requestError instanceof TypeError,
        });
      trackProductEvent("checkout_failed", 0, {
        cta_location: ctaLocation,
        purchase_type: "credit_pack",
        pack_id: packId,
        failure_stage: "checkout_session",
        error_code: analyticsErrorCode(code),
      });
      if (requiresReauthentication(code)) {
        trackProductEvent("authentication_required", 0, {
          cta_location: ctaLocation,
          purchase_type: "credit_pack",
          pack_id: packId,
          authentication_state: "unauthenticated",
          error_code: analyticsErrorCode(code),
        });
        onAuthenticationRequired?.(code);
      }
      setErrorCode(code);
      setBuying(null);
      checkoutInFlightRef.current = false;
      checkoutStartedForRef.current = null;
    }
  };

  const orderedPacks = useMemo(() => {
    if (!packs) return null;
    const preferred = normalizeCreditPackId(initialPackId);
    if (!preferred) return packs;
    const chosen = packs.filter((pack) => pack.id === preferred);
    return chosen.length ? [...chosen, ...packs.filter((pack) => pack.id !== preferred)] : packs;
  }, [initialPackId, packs]);

  const errorMessage = errorCode ? billingErrorMessage(errorCode, lang) : "";

  return (
    <>
      {hideTrigger ? null : (
        <button
          ref={triggerRef}
          type="button"
          data-testid={testId || "credit-pack-purchase-trigger"}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? "credit-pack-modal" : undefined}
          onClick={(event) => {
            returnFocusRef.current = event.currentTarget;
            resetPurchaseState();
            trackProductEvent("credit_pack_cta_click", 0, {
              cta_location: ctaLocation,
              purchase_type: "credit_pack",
              authentication_state: "authenticated",
              trigger: normalizePurchaseAnalyticsTrigger(trigger),
              ...(normalizeCreditPackId(initialPackId)
                ? { pack_id: normalizeCreditPackId(initialPackId)! }
                : {}),
            });
            setOpen(true);
          }}
          className={className || "font-bold text-amber-900 underline underline-offset-2 dark:text-amber-100"}
        >
          {children || text.title}
        </button>
      )}
      {open && typeof document !== "undefined" && createPortal(
        /*
         * z-[150] rather than the z-[120] this overlay used to sit at. This
         * modal is opened from *inside* other overlays -- account User
         * Settings renders at z-[130] and its own nested dialogs (delete
         * account, sign-out confirm) at z-[140] -- so anything at or below
         * those layers is painted underneath the panel that opened it: present
         * in the DOM, `open`, and both invisible and unclickable. The portal
         * target stays `document.body`, because moving it inside the settings
         * panel would clip it against that panel's `overflow-hidden`, and the
         * settings modal deliberately stays open underneath.
         */
        <div className="fixed inset-0 z-[150] flex items-end justify-center bg-black/65 p-3 backdrop-blur-sm sm:items-center" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section
            id="credit-pack-modal"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="credit-pack-title"
            data-testid="credit-pack-modal"
            className="max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-3xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 id="credit-pack-title" className="flex min-w-0 items-center gap-2 text-xl font-black text-zinc-950 dark:text-white"><Coins className="h-5 w-5 shrink-0 text-emerald-500" /><span className="min-w-0 break-words">{text.title}</span></h2>
                <p className="mt-1 min-w-0 break-words text-sm text-zinc-500 dark:text-zinc-400">{text.body}</p>
              </div>
              {/* UI-TOUCH-001's 44px floor: this is the only pointer-driven way
                  out of a modal that covers the page. */}
              <button ref={closeButtonRef} type="button" onClick={() => setOpen(false)} aria-label={text.close} data-testid="credit-pack-modal-close" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl p-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900"><X className="h-5 w-5" /></button>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {packs === null && !errorCode && (
                <p role="status" className="text-sm text-zinc-500">{text.loading}</p>
              )}
              {orderedPacks?.map((pack) => {
                const isSelected = selectedPackId === pack.id;
                return (
                <article
                  key={pack.id}
                  data-pack-id={pack.id}
                  data-selected={isSelected ? "true" : "false"}
                  // The selected state is carried by a border, a ring, and a
                  // written "Selected" label -- never by colour alone.
                  className={`min-w-0 rounded-2xl border p-4 ${
                    isSelected
                      ? "border-emerald-600 ring-2 ring-emerald-600/30 dark:border-emerald-400"
                      : "border-zinc-200 dark:border-zinc-800"
                  }`}
                >
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <p className="min-w-0 break-words text-sm font-bold text-zinc-950 dark:text-white">{pack.name}</p>
                    {isSelected ? (
                      <span className="shrink-0 rounded-full bg-emerald-600/10 px-2 py-0.5 text-[11px] font-bold text-emerald-700 dark:text-emerald-300">
                        {text.selected}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 min-w-0 break-words text-2xl font-black text-zinc-950 dark:text-white">{pack.credits.toLocaleString(lang)} <span className="text-sm text-zinc-500">{creditUnit[lang]}</span></p>
                  <p className="mt-1 text-xs text-zinc-500">{text.expiry}</p>
                  <button
                    type="button"
                    disabled={Boolean(buying)}
                    aria-busy={buying === pack.id}
                    data-testid={`credit-pack-buy-${pack.id}`}
                    onClick={() => {
                      setSelectedPackId(pack.id);
                      void buy(pack.id);
                    }}
                    // `min-h-11` rather than a fixed height: a label that wraps
                    // at 200% text has to grow the button, not spill out of it.
                    className="mt-4 flex min-h-11 w-full items-center justify-center rounded-xl bg-emerald-600 px-3 py-2.5 text-center text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-60"
                  >
                    {buying === pack.id
                      ? text.loading
                      : `${text.buy} · ${formatBillingMinor(pack.priceMinor, pack.currency, lang)}`}
                  </button>
                </article>
                );
              })}
            </div>
            {errorCode && (
              <div
                role="alert"
                data-testid="credit-pack-error"
                data-error-code={errorCode}
                className="mt-3 rounded-2xl border border-red-200 bg-red-50 p-3 dark:border-red-900/60 dark:bg-red-950/30"
              >
                <p className="text-sm font-semibold text-red-700 dark:text-red-200">{errorMessage}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {requiresReauthentication(errorCode) ? (
                    <a
                      href={signInHref}
                      data-testid="credit-pack-reauthenticate"
                      className="inline-flex min-h-11 items-center justify-center rounded-xl bg-zinc-900 px-4 py-2 text-sm font-bold text-white dark:bg-white dark:text-zinc-950"
                    >
                      {ctaText.signInAgain}
                    </a>
                  ) : null}
                  {isRetryableBillingError(errorCode) ? (
                    <button
                      type="button"
                      data-testid="credit-pack-retry"
                      onClick={() => {
                        setErrorCode(null);
                        setPacks(null);
                        setLoadAttempt((attempt) => attempt + 1);
                      }}
                      className="inline-flex min-h-11 items-center justify-center rounded-xl border border-red-300 px-4 py-2 text-sm font-bold text-red-800 dark:border-red-800 dark:text-red-100"
                    >
                      {ctaText.retry}
                    </button>
                  ) : null}
                  {requiresSupport(errorCode) ? (
                    <Link
                      href="/support"
                      className="inline-flex min-h-11 items-center justify-center rounded-xl border border-red-300 px-4 py-2 text-sm font-bold text-red-800 dark:border-red-800 dark:text-red-100"
                    >
                      {ctaText.contactSupport}
                    </Link>
                  ) : null}
                </div>
              </div>
            )}
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
