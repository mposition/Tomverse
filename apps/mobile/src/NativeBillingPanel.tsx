import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { Purchases, type PurchasesStoreProduct } from "@revenuecat/purchases-capacitor";
import { Coins, CreditCard, ExternalLink, RefreshCw, RotateCcw } from "lucide-react";
import { mobileApiFetch } from "./authBridge";
import { canPurchaseMobileProduct, createNativeBillingClient, type MobileBillingState, type MobileStore } from "./billingClient";
import type { MobileLanguage } from "../../../locales/mobile";
import { formatMobileBillingCopy, mobileBillingCopy, type MobileBillingCopyKey } from "../../../locales/mobileBilling";
import { PurchaseConfirmation } from "./PurchaseConfirmation";
import { confirmedPurchase, type PurchaseConfirmation as Confirmation, type PurchaseObservation } from "./billingPurchaseResult";
import "./billing.css";

export function NativeBillingPanel({ language, onClose }: { language: MobileLanguage; onClose?: () => void }) {
  const c = mobileBillingCopy(language);
  const number = (value: number | undefined) => (value ?? 0).toLocaleString(language);
  const date = (value: string) => new Date(value).toLocaleDateString(language);
  const [state, setState] = useState<MobileBillingState | null>(null);
  const [products, setProducts] = useState<PurchasesStoreProduct[]>([]);
  const [busy, setBusy] = useState(() => Capacitor.isNativePlatform());
  const [message, setMessage] = useState<MobileBillingCopyKey | "">("");
  const [error, setError] = useState<MobileBillingCopyKey | "">(() => Capacitor.isNativePlatform() ? "" : "installedOnly");
  const [interval, setInterval] = useState("monthly");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [promoCode, setPromoCode] = useState("");
  const [passStatus, setPassStatus] = useState<MobileBillingCopyKey | "">("");
  const [redeemingPass, setRedeemingPass] = useState(false);
  const [reload, setReload] = useState(0);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [checkingPurchase, setCheckingPurchase] = useState(false);
  const pendingPurchase = useRef<PurchaseObservation | null>(null);
  const client = useRef<ReturnType<typeof createNativeBillingClient> | null>(null);
  const alive = useRef(false);
  const action = useRef(false);
  const store: MobileStore = Capacitor.getPlatform() === "ios" ? "app_store" : "play_store";
  const storeName = store === "app_store" ? "App Store" : "Google Play";
  const [creditPrefix, creditSuffix = ""] = c.purchasedCredits.split("{credits}");
  const acceptState = useCallback((value: MobileBillingState) => {
    setState(value);
    const pending = pendingPurchase.current;
    if (!pending) return;
    if (pending.before.billingId !== value.billingId) { pendingPurchase.current = null; setCheckingPurchase(false); return; }
    const result = confirmedPurchase(pending, value);
    if (result) {
      pendingPurchase.current = null; setCheckingPurchase(false); setMessage(""); setError(""); setConfirmation(result);
      return true;
    }
    return false;
  }, []);
  useEffect(() => {
    let mounted = true; alive.current = true;
    if (!Capacitor.isNativePlatform()) {
      return () => { mounted = false; alive.current = false; };
    }
    const billing = createNativeBillingClient({ sdk: Purchases, api: mobileApiFetch, store,
      apiKey: store === "app_store" ? import.meta.env.VITE_REVENUECAT_APPLE_API_KEY || "" : import.meta.env.VITE_REVENUECAT_GOOGLE_API_KEY || "",
      isCurrent: () => mounted });
    client.current = billing;
    void (async () => {
      const value = await billing.refresh();
      if (!mounted) return;
      setState(value); setInterval(value.interval || "monthly");
      try {
        const available = await billing.catalog(value);
        if (mounted) setProducts(available);
      } catch {
        if (mounted) setError("catalogFailed");
      }
    })().catch(() => { if (mounted) setError("planFailed"); }).finally(() => { if (mounted) setBusy(false); });
    const refresh = () => { if (document.visibilityState === "visible" && !action.current) void billing.refresh().then((value) => { if (mounted) acceptState(value); }).catch(() => {}); };
    document.addEventListener("visibilitychange", refresh); window.addEventListener("focus", refresh);
    return () => { mounted = false; alive.current = false; document.removeEventListener("visibilitychange", refresh); window.removeEventListener("focus", refresh); };
  }, [store, storeName, reload, acceptState]);
  const retryCatalog = () => { setBusy(true); setError(""); setProducts([]); setReload(value => value + 1); };
  useEffect(() => {
    if (!checkingPurchase || busy) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const check = async () => {
      if (cancelled || !pendingPurchase.current) return;
      try { const value = await client.current!.refresh(); if (!cancelled && alive.current) acceptState(value); } catch { /* Manual refresh remains available. */ }
      if (!cancelled && pendingPurchase.current && ++attempts < 3) timer = setTimeout(check, 4000);
    };
    timer = setTimeout(check, 2500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [checkingPurchase, busy, acceptState]);
  const run = async (work: () => Promise<MobileBillingState>, success: MobileBillingCopyKey) => {
    if (action.current) return;
    action.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const value = await work();
      if (alive.current) { setMessage(pendingPurchase.current ? "" : success); acceptState(value); }
      try {
        const available = await client.current!.catalog(value);
        if (alive.current) setProducts(available);
      } catch { if (alive.current) setError("catalogFailed"); }
    }
    catch (cause) {
      let confirmed = false;
      try { const latest = await client.current!.refresh(); if (alive.current) confirmed = acceptState(latest) === true; } catch { /* Keep the last verified view if the server is unavailable. */ }
      const code = typeof cause === "object" && cause ? String((cause as { code?: unknown }).code) : "";
      if (alive.current && !confirmed && code !== "1") {
        if (code === "20") setMessage("paymentPending");
        else setError("resultUnconfirmed");
      }
    } finally { action.current = false; if (alive.current) setBusy(false); }
  };
  const purchase = (product: PurchasesStoreProduct) => run(() => client.current!.purchase(product, before => {
    // Store-managed downgrades take effect at renewal, not when the sheet closes.
    const item = before.products.find(item => item.productId === product.identifier);
    if (before.active && before.plan === "Max" && item?.kind === "subscription" && item.plan === "Pro") return;
    pendingPurchase.current = { before, productId: product.identifier };
    if (alive.current) setCheckingPurchase(true);
  }), "storeCompleted");
  const redeemPass = async () => {
    if (action.current || !client.current) return;
    action.current = true; setBusy(true); setRedeemingPass(true); setPassStatus("");
    try {
      const value = await client.current.redeemPass(promoCode, language);
      if (alive.current) { acceptState(value); setPromoCode(""); setPassStatus("passApplied"); }
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      const key: MobileBillingCopyKey = code === "PROMOTION_ALREADY_USED" ? "passUsed"
        : code === "PROMOTION_EXPIRED" || code === "PROMOTION_REDEMPTION_LIMIT_REACHED" ? "passExpired"
        : code === "NATIVE_PASS_UNAVAILABLE" ? "passUnavailable"
        : code === "PROMOTION_INVALID" || code === "NATIVE_PASS_REQUIRED" || code === "PROMOTION_UNAVAILABLE" || code === "PROMOTION_NOT_STARTED" ? "passInvalid"
        : ["PROMOTION_PLAN_NOT_ELIGIBLE", "PLAN_CHANGE_NOT_SUPPORTED", "ACTIVE_SUBSCRIPTION_EXISTS", "STORE_SUBSCRIPTION_MANAGED_EXTERNALLY", "INTERNAL_PASS_NOT_ELIGIBLE"].includes(code) ? "passIneligible" : "passUnconfirmed";
      if (alive.current) setPassStatus(key);
    } finally { action.current = false; if (alive.current) { setBusy(false); setRedeemingPass(false); } }
  };
  const manage = async () => {
    if (!state?.subscriptionStore || state.subscriptionStore === "web") return;
    await Browser.open({ url: state.subscriptionStore === "app_store" ? "https://apps.apple.com/account/subscriptions" : "https://play.google.com/store/account/subscriptions" });
  };
  return <section className="native-billing" aria-labelledby="native-billing-title" data-testid="native-billing">
    <div className="native-billing-heading"><h2 id="native-billing-title">{c.title}</h2>{onClose && <button type="button" onClick={onClose} disabled={busy}>{c.back}</button>}</div>
    {checkingPurchase && <div className="purchase-verifying" role="status"><strong>{c.purchaseChecking}</strong><p>{c.purchaseCheckingDescription}</p></div>}
    {confirmation && <PurchaseConfirmation confirmation={confirmation} language={language} onClose={() => setConfirmation(null)} />}
    {busy && <p role="status">{redeemingPass ? c.passApplying : formatMobileBillingCopy(c.connecting, { store: storeName })}</p>}
    {state && <>
      {state.verificationPending && <p role="status">{c.verificationPending}</p>}
      {state.subscriptionPurchaseAttempt && <p role="status">{c.subscriptionPending}</p>}
      {!!state.creditPurchasesNeedingReview && <p role="alert">{c.creditReview}</p>}
      <div className="native-billing-current"><h3><CreditCard size={22} aria-hidden="true" /><span>{formatMobileBillingCopy(c.currentPlan, { plan: state.plan })}</span></h3><p className="native-billing-balance"><span>{creditPrefix}</span>{" "}<strong>{number(state.purchasedCredits)}{creditSuffix}</strong></p>
        {state.active && state.expiresAt && <p>{formatMobileBillingCopy(state.cancelAtPeriodEnd ? c.accessUntil : c.renews, { date: date(state.expiresAt) })}</p>}
        {state.accessPass && <p>{formatMobileBillingCopy(c.passAccessUntil, { date: date(state.accessPass.expiresAt) })}</p>}
      </div>
      {state.subscriptionStore !== "web" && state.webSubscription?.active && <p role="alert">{c.overlap}</p>}
      {state.active && state.subscriptionStore !== store && <p>{c.originalProvider}</p>}
      {state.active && state.cancelAtPeriodEnd && <p>{c.cancelledRenewal}</p>}
      <h3 className="native-billing-plan-heading">{c.choose}</h3>
      <div role="group" aria-label={c.billingPeriod} className="native-billing-interval">
        <button type="button" aria-pressed={interval === "monthly"} onClick={() => setInterval("monthly")} disabled={busy}>{c.monthly}</button>
        <button type="button" aria-pressed={interval === "annual"} onClick={() => setInterval("annual")} disabled={busy}>{c.annual}</button>
      </div>
      <div className="native-billing-products native-billing-plans">{state.products.filter((p) => p.kind === "subscription" && p.interval === interval).map((item) => {
        if (item.kind !== "subscription") return null;
        const product = products.find((p) => p.identifier === item.productId);
        return <article key={item.productId} data-featured={item.plan === "Max" || undefined}><h4>{item.plan}</h4>
          <p className="native-billing-price"><strong>{product?.priceString || c.unavailable}</strong><span> / {interval === "annual" ? c.priceYear : c.priceMonth}</span></p>
          <p className="native-billing-benefits">{formatMobileBillingCopy(c.planBenefitCompact, { credits: number(item.monthlyCredits), models: number(item.maxModels) })}</p>
          <button type="button" disabled={busy || !product || !canPurchaseMobileProduct(state, item, store)} onClick={() => { void purchase(product!); }}>
            {item.kind === "subscription" && state.active && state.plan === item.plan ? c.currentPlanButton : state.active ? c.changePlan : c.subscribe}
          </button></article>;
      })}</div>

      <form className="native-billing-promotion" onSubmit={event => { event.preventDefault(); void redeemPass(); }}>
        <label htmlFor="native-promotion-code">{c.promotionCode}</label>
        <p id="native-promotion-description">{c.passDescription}</p>
        <div><input id="native-promotion-code" value={promoCode} onChange={event => { setPromoCode(event.target.value); setPassStatus(""); }}
          autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={32} disabled={busy}
          aria-describedby="native-promotion-description" />
          <button type="submit" disabled={busy || !state.promotionPasses || promoCode.trim().length < 2}>{c.applyCode}</button></div>
        {!state.promotionPasses && <p>{c.passUnavailable}</p>}
        {passStatus && <p role={passStatus === "passApplied" ? "status" : "alert"}>{c[passStatus]}</p>}
      </form>

      <h3>{c.additionalCredits}</h3><p className="native-billing-credit-terms">{c.creditTerms}</p>
      <div className="native-billing-products native-billing-credit-list">{state.products.filter((p) => p.kind === "credits").map((item) => {
        const product = products.find((p) => p.identifier === item.productId);
        return <article key={item.productId}><Coins size={20} aria-hidden="true" /><div className="native-billing-credit-copy"><h4>{formatMobileBillingCopy(c.creditPack, { credits: number(item.credits) })}</h4><p>{product?.priceString || c.unavailable}</p></div>
          <button type="button" disabled={busy || !product || !canPurchaseMobileProduct(state, item, store)} onClick={() => { void purchase(product!); }}>{c.buyCredits}</button></article>;
      })}</div>
      <div className="native-billing-management">
        {state.active && state.subscriptionStore && state.subscriptionStore !== "web" && <button type="button" disabled={busy} onClick={() => { void manage().catch(() => setError("managementFailed")); }}><CreditCard size={18} aria-hidden="true" /><span>{c.manage}</span><ExternalLink size={15} aria-hidden="true" /></button>}
        {[...new Set(state.storeSubscriptions?.map((entry) => entry.store) || [])].filter((provider) => provider !== state.subscriptionStore).map((provider) =>
          <button key={provider} type="button" disabled={busy} onClick={() => { void Browser.open({ url: provider === "app_store" ? "https://apps.apple.com/account/subscriptions" : "https://play.google.com/store/account/subscriptions" }).catch(() => setError("managementFailed")); }}>
            {formatMobileBillingCopy(c.manageStore, { store: provider === "app_store" ? "App Store" : "Google Play" })}
          </button>)}
        {state.active && (state.subscriptionStore === "web" || state.webSubscription?.active) && <><p>{c.webDescription}</p>
          {state.webSubscription?.expiresAt && <p>{formatMobileBillingCopy(c.webAccessUntil, { date: date(state.webSubscription.expiresAt) })}</p>}
          {!(state.webSubscription?.cancelAtPeriodEnd ?? state.cancelAtPeriodEnd) && <button type="button" disabled={busy} onClick={() => setConfirmCancel(true)}>{c.cancel}</button>}
          {confirmCancel && <div role="group" aria-label={c.confirmCancel}><p>{c.confirmCancelPrompt}</p>
            <button type="button" disabled={busy} onClick={() => { setConfirmCancel(false); void run(() => client.current!.cancelWeb(), "renewalCancelled"); }}>{c.confirmCancel}</button>
            <button type="button" disabled={busy} onClick={() => setConfirmCancel(false)}>{c.keep}</button></div>}
        </>}
      </div>
      {!busy && !products.length && <><p>{c.noProducts}</p>{!error && <button type="button" onClick={retryCatalog}>{c.retry}</button>}</>}
    </>}
    {state && <details className="native-billing-details"><summary>{c.planInformation}</summary><p>{c.planDescription}</p></details>}
    {state && <p className="native-billing-subscription-terms">{c.subscriptionTerms}</p>}
    <div className="native-billing-actions"><button type="button" disabled={busy || !state} onClick={() => { void run(() => client.current!.refresh(), "balanceRefreshed"); }}><RefreshCw size={16} aria-hidden="true" />{c.refreshBalance}</button>
      <button type="button" disabled={busy || !state} onClick={() => { void run(() => client.current!.restore(), "purchasesRestored"); }}><RotateCcw size={16} aria-hidden="true" />{c.restore}</button></div>
    <p className="native-billing-legal"><a href="https://tomverse.app/terms" target="_blank" rel="noreferrer">{c.terms}<ExternalLink size={12} aria-hidden="true" /></a><a href="https://tomverse.app/privacy" target="_blank" rel="noreferrer">{c.privacy}<ExternalLink size={12} aria-hidden="true" /></a></p>
    {message && <p role="status">{c[message]}</p>}{error && <><p role="alert">{formatMobileBillingCopy(c[error], { store: storeName })}</p>{Capacitor.isNativePlatform() && <button type="button" disabled={busy} onClick={retryCatalog}>{c.retry}</button>}</>}
  </section>;
}
