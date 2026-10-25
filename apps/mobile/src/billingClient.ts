import type { PurchasesPlugin, PurchasesStoreProduct } from "@revenuecat/purchases-capacitor";
import { PRODUCT_CATEGORY, STORE_REPLACEMENT_MODE } from "@revenuecat/purchases-capacitor";
import type { MobileBillingProduct, MobileBillingState, MobileStore } from "../../../lib/mobileBillingCore";
import type { NativeChatTransport } from "./chatClient";

export type { MobileBillingProduct, MobileBillingState, MobileStore };
// Serialize SDK identity changes and purchases across accounts and StrictMode remounts.
let queue: Promise<unknown> = Promise.resolve();
let configured = false;
const serialized = <T,>(work: () => Promise<T>): Promise<T> => {
  const result = queue.then(work, work);
  queue = result.catch(() => {});
  return result;
};
export function canPurchaseMobileProduct(state: MobileBillingState, product: MobileBillingProduct, store: MobileStore) {
  if (product.store !== store) return false;
  if (product.kind === "credits") return state.products.some((p) => p.productId === product.productId);
  if (!state.active) return true;
  return state.subscriptionStore === store && !state.cancelAtPeriodEnd && state.interval === product.interval && state.plan !== product.plan;
}
export function createNativeBillingClient(input: {
  sdk: PurchasesPlugin; api: NativeChatTransport; store: MobileStore; apiKey: string; isCurrent: () => boolean;
}) {
  const current = () => { if (!input.isCurrent()) throw new Error("BILLING_ACCOUNT_CHANGED"); };
  const sync = async (action: "sync" | "cancel_web" = "sync") => {
    current();
    const response = await input.api("/api/mobile/billing", () => {
      current();
      return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, store: input.store }) };
    });
    current();
    if (!response.ok) throw new Error(response.status === 503 ? "BILLING_UNAVAILABLE" : "BILLING_SYNC_FAILED");
    return response.json() as Promise<MobileBillingState>;
  };
  const identify = async (state: MobileBillingState) => {
    current();
    if (!input.apiKey) throw new Error("BILLING_UNAVAILABLE");
    if (!configured) { await input.sdk.configure({ apiKey: input.apiKey, appUserID: state.billingId }); configured = true; }
    else await input.sdk.logIn({ appUserID: state.billingId });
    current();
  };
  const readProducts = async (state: MobileBillingState) => {
      const products: PurchasesStoreProduct[] = [];
      for (const kind of ["subscription", "credits"] as const) {
        const ids = state.products.filter((p) => p.kind === kind).map((p) => p.productId);
        if (ids.length) products.push(...(await input.sdk.getProducts({ productIdentifiers: ids,
          type: kind === "subscription" ? PRODUCT_CATEGORY.SUBSCRIPTION : PRODUCT_CATEGORY.NON_SUBSCRIPTION })).products);
      }
      current(); return products;
  };
  return {
    catalog: (state: MobileBillingState) => serialized(async () => { await identify(state); return readProducts(state); }),
    load: () => serialized(async () => {
      const state = await sync(); await identify(state);
      return { state, products: await readProducts(state) };
    }),
    purchase: (product: PurchasesStoreProduct) => serialized(async () => {
      const state = await sync();
      const item = state.products.find((p) => p.productId === product.identifier);
      if (!item || !canPurchaseMobileProduct(state, item, input.store)) throw new Error("BILLING_PLAN_CHANGED");
      await identify(state); current();
      await input.sdk.purchaseStoreProduct({ product, ...(input.store === "play_store" && item.kind === "subscription" && state.active && state.productId ? {
        storeProductChangeInfo: { oldProductIdentifier: state.productId,
          replacementMode: item.plan === "Max" ? STORE_REPLACEMENT_MODE.CHARGE_PRORATED_PRICE : STORE_REPLACEMENT_MODE.DEFERRED },
      } : {}) });
      // Only the server/webhook grants access; pending payment keeps the old plan.
      current(); return sync();
    }),
    restore: () => serialized(async () => {
      const state = await sync(); await identify(state); await input.sdk.restorePurchases(); current(); return sync();
    }),
    refresh: () => serialized(() => sync()),
    cancelWeb: () => serialized(() => sync("cancel_web")),
  };
}
