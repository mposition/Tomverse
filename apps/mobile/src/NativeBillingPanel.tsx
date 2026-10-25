import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { Purchases, type PurchasesStoreProduct } from "@revenuecat/purchases-capacitor";
import { mobileApiFetch } from "./authBridge";
import { canPurchaseMobileProduct, createNativeBillingClient, type MobileBillingState, type MobileStore } from "./billingClient";

export function NativeBillingPanel({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<MobileBillingState | null>(null);
  const [products, setProducts] = useState<PurchasesStoreProduct[]>([]);
  const [busy, setBusy] = useState(() => Capacitor.isNativePlatform());
  const [message, setMessage] = useState("");
  const [error, setError] = useState(() => Capacitor.isNativePlatform() ? "" : "Purchases are available in the installed iOS or Android app.");
  const [interval, setInterval] = useState("monthly");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const client = useRef<ReturnType<typeof createNativeBillingClient> | null>(null);
  const alive = useRef(false);
  const action = useRef(false);
  const store: MobileStore = Capacitor.getPlatform() === "ios" ? "app_store" : "play_store";
  const storeName = store === "app_store" ? "App Store" : "Google Play";
  useEffect(() => {
    let mounted = true; alive.current = true;
    if (!Capacitor.isNativePlatform()) {
      return () => { mounted = false; alive.current = false; };
    }
    const billing = createNativeBillingClient({ sdk: Purchases, api: mobileApiFetch, store,
      apiKey: store === "app_store" ? import.meta.env.VITE_REVENUECAT_APPLE_API_KEY || "" : import.meta.env.VITE_REVENUECAT_GOOGLE_API_KEY || "",
      isCurrent: () => mounted });
    client.current = billing;
    void billing.load().then(({ state: value, products: available }) => {
      if (mounted) { setState(value); setProducts(available); setInterval(value.interval || "monthly"); }
    }).catch(() => { if (mounted) setError("Store billing is unavailable. Please try again."); }).finally(() => { if (mounted) setBusy(false); });
    const refresh = () => { if (document.visibilityState === "visible" && !action.current) void billing.refresh().then((value) => { if (mounted) setState(value); }).catch(() => {}); };
    document.addEventListener("visibilitychange", refresh); window.addEventListener("focus", refresh);
    return () => { mounted = false; alive.current = false; document.removeEventListener("visibilitychange", refresh); window.removeEventListener("focus", refresh); };
  }, [store]);
  const run = async (work: () => Promise<MobileBillingState>, success: string) => {
    if (action.current) return;
    action.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const value = await work();
      if (alive.current) { setState(value); setMessage(success); }
      const available = await client.current!.catalog(value);
      if (alive.current) setProducts(available);
    }
    catch (cause) {
      const code = typeof cause === "object" && cause ? String((cause as { code?: unknown }).code) : "";
      if (alive.current && code !== "1") {
        if (code === "20") setMessage("Payment is pending approval. Your plan and balance will update after the store confirms payment.");
        else setError("We could not confirm the result. Refresh your balance or restore purchases before trying another purchase.");
      }
    } finally { action.current = false; if (alive.current) setBusy(false); }
  };
  const manage = async () => {
    if (!state?.subscriptionStore || state.subscriptionStore === "web") return;
    await Browser.open({ url: state.subscriptionStore === "app_store" ? "https://apps.apple.com/account/subscriptions" : "https://play.google.com/store/account/subscriptions" });
  };
  return <section className="native-billing" aria-labelledby="native-billing-title" data-testid="native-billing">
    <div className="native-billing-heading"><h2 id="native-billing-title">Plans & credits</h2><button type="button" onClick={onClose} disabled={busy}>Back to chat</button></div>
    {busy && <p role="status">Connecting to {storeName}…</p>}
    {state && <>
      <div className="native-billing-current"><h3>Current plan: {state.plan}</h3><p>Purchased credits: {state.purchasedCredits.toLocaleString()}</p>
        {state.active && state.expiresAt && <p>{state.cancelAtPeriodEnd ? "Access until" : "Renews"}: {new Date(state.expiresAt).toLocaleDateString()}</p>}
        {state.active && state.subscriptionStore && state.subscriptionStore !== "web" && <button type="button" disabled={busy} onClick={() => { void manage().catch(() => setError("Unable to open subscription management.")); }}>Manage or cancel subscription</button>}
        {[...new Set(state.storeSubscriptions?.map((entry) => entry.store) || [])].filter((provider) => provider !== state.subscriptionStore).map((provider) =>
          <button key={provider} type="button" disabled={busy} onClick={() => { void Browser.open({ url: provider === "app_store" ? "https://apps.apple.com/account/subscriptions" : "https://play.google.com/store/account/subscriptions" }).catch(() => setError("Unable to open subscription management.")); }}>
            Manage {provider === "app_store" ? "App Store" : "Google Play"} subscription
          </button>)}
        {state.active && (state.subscriptionStore === "web" || state.webSubscription?.active) && <><p>Your web subscription is managed by Tomverse. Cancel renewal here; access continues until the end of the paid period.</p>
          {state.webSubscription?.expiresAt && <p>Web subscription access until: {new Date(state.webSubscription.expiresAt).toLocaleDateString()}</p>}
          {!(state.webSubscription?.cancelAtPeriodEnd ?? state.cancelAtPeriodEnd) && <button type="button" disabled={busy} onClick={() => setConfirmCancel(true)}>Cancel subscription</button>}
          {confirmCancel && <div role="group" aria-label="Confirm cancellation"><p>Cancel automatic renewal? Your paid access continues until the date above.</p>
            <button type="button" disabled={busy} onClick={() => { setConfirmCancel(false); void run(() => client.current!.cancelWeb(), "Automatic renewal has been cancelled."); }}>Confirm cancellation</button>
            <button type="button" disabled={busy} onClick={() => setConfirmCancel(false)}>Keep subscription</button></div>}
        </>}
      </div>
      {state.subscriptionStore !== "web" && state.webSubscription?.active && <p role="alert">You have subscriptions with both providers. You can cancel web renewal here and manage your store subscription separately. Your credit allowance is shared and is not doubled.</p>}
      {state.active && state.subscriptionStore !== store && <p>To avoid a second subscription, change your plan through its original provider. You can still buy additional credits here.</p>}
      {state.active && state.cancelAtPeriodEnd && <p>Renewal is cancelled. Use subscription management to resume renewal before changing plans.</p>}
      <h3>Choose a plan</h3>
      <div role="group" aria-label="Billing period" className="native-billing-actions">
        <button type="button" aria-pressed={interval === "monthly"} onClick={() => setInterval("monthly")} disabled={busy}>Monthly</button>
        <button type="button" aria-pressed={interval === "annual"} onClick={() => setInterval("annual")} disabled={busy}>Annual</button>
      </div>
      <p>Free chat is available without a subscription. Paid plans include ongoing access to premium models and a monthly credit allowance, resetting each UTC calendar month.</p>
      <div className="native-billing-products">{state.products.filter((p) => p.kind === "subscription" && p.interval === interval).map((item) => {
        const product = products.find((p) => p.identifier === item.productId);
        return <article key={item.productId}><h4>{item.kind === "subscription" ? item.plan : ""}</h4><p>{item.monthlyCredits?.toLocaleString()} plan credits each month · up to {item.maxModels} models per comparison</p>
          <p>{product?.priceString || "Unavailable"} / {interval === "annual" ? "year" : "month"}</p>
          <button type="button" disabled={busy || !product || !canPurchaseMobileProduct(state, item, store)} onClick={() => { void run(() => client.current!.purchase(product!), "Store request completed. Verified changes appear here; if still processing, refresh your balance."); }}>
            {item.kind === "subscription" && state.active && state.plan === item.plan ? "Current plan" : state.active ? "Change plan" : "Subscribe"}
          </button></article>;
      })}</div>
      <p>Subscriptions renew automatically at the displayed price and billing period until cancelled in subscription management. The store confirmation shows the final charge and effective date. Upgrades apply after payment confirmation; downgrades apply at the end of the paid period.</p>
      <h3>Additional credits</h3><p>One-time purchases. Purchased credits do not expire and remain available after cancellation.</p>
      <div className="native-billing-products">{state.products.filter((p) => p.kind === "credits").map((item) => {
        const product = products.find((p) => p.identifier === item.productId);
        return <article key={item.productId}><h4>{item.credits?.toLocaleString()} credits</h4><p>{product?.priceString || "Unavailable"}</p>
          <button type="button" disabled={busy || !product} onClick={() => { void run(() => client.current!.purchase(product!), "Purchase submitted. Credits appear after store verification; refresh if the payment is still processing."); }}>Buy credits</button></article>;
      })}</div>
      {!products.length && <p>No store products are available. Please try again later.</p>}
    </>}
    <div className="native-billing-actions"><button type="button" disabled={busy || !state} onClick={() => { void run(() => client.current!.refresh(), "Balance refreshed."); }}>Refresh balance</button>
      <button type="button" disabled={busy || !state} onClick={() => { void run(() => client.current!.restore(), "Purchases restored for this Tomverse account. Purchased credits remain in your account balance."); }}>Restore purchases</button></div>
    <p><a href="https://tomverse.app/terms" target="_blank" rel="noreferrer">Terms of Use</a> · <a href="https://tomverse.app/privacy" target="_blank" rel="noreferrer">Privacy Policy</a></p>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
