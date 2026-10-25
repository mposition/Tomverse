import { test, expect, type Page } from "@playwright/test";

async function installBilling(page: Page, web = false, overlap = false, bothStores = false, pending = false) {
  const calls: { plugin: string; method: string; options: Record<string, unknown> }[] = [];
  await page.exposeFunction("billingCall", (call: typeof calls[number]) => { calls.push(call); });
  await page.addInitScript((pending) => {
    const device = window as unknown as { androidBridge: object; Capacitor: object; billingCall: (call: unknown) => Promise<void> };
    device.androidBridge = {};
    const methods = { MobileAuth: ["hasSession", "getAccessToken", "signOut"],
      Purchases: ["configure", "logIn", "getProducts", "purchaseStoreProduct", "restorePurchases"], Browser: ["open"] };
    device.Capacitor = {
      PluginHeaders: Object.entries(methods).map(([name, names]) => ({ name, methods: names.map((name) => ({ name, rtype: "promise" })) })),
      nativePromise: async (plugin: string, method: string, options: Record<string, unknown> = {}) => {
        await device.billingCall({ plugin, method, options });
        if (plugin === "MobileAuth") return method === "hasSession" ? { signedIn: true } : { accessToken: "test-access", expiresAt: Date.now() + 600000 };
        if (method === "getProducts") return { products: (options.productIdentifiers as string[]).map((identifier) => ({ identifier, priceString: identifier === "credits" ? "A$7.49" : "A$29.99" })) };
        if (pending && method === "purchaseStoreProduct") throw { code: "20" };
        return {};
      },
    };
  }, pending);
  let purchasedCredits = 500; let cancelled = false;
  let subscriptionPurchaseAttempt: { id: string; store: string; productId: string; startedAt: string } | null = null;
  await page.route("https://api.native-chat.test/**", async (route) => {
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization,Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/user/account") return route.fulfill({ json: { id: "billing-user", name: "Billing user", email: "billing@example.test", actionsEnabled: false }, headers });
    if (path === "/api/conversations") return route.fulfill({ json: [], headers });
    if (path === "/api/models/catalog") return route.fulfill({ json: { models: [] }, headers });
    if (path === "/api/user/usage") return route.fulfill({ json: { plan: "Pro", usage: { creditsMonth: 0 }, limits: { creditsMonth: 3000 } }, headers });
    if (path === "/api/products/chat/capabilities") return route.fulfill({ json: { autoSelection: { offered: false } }, headers });
    if (path !== "/api/mobile/billing") return route.fulfill({ json: {}, headers });
    if (route.request().postDataJSON().action === "cancel_web") cancelled = true;
    if (pending && route.request().postDataJSON().action === "prepare_subscription_purchase") subscriptionPurchaseAttempt = { id: "pending-request", store: "play_store", productId: "max:monthly", startedAt: new Date().toISOString() };
    if (calls.some((c) => c.method === "purchaseStoreProduct" && (c.options.product as { identifier: string }).identifier === "credits")) purchasedCredits = 1000;
    await route.fulfill({ headers, json: {
      billingId: "billing-account", plan: "Pro", subscriptionStore: web ? "web" : "play_store", productId: "pro:monthly", subscriptionPurchaseAttempt,
      interval: "monthly", expiresAt: "2026-11-25T00:00:00Z", active: true, cancelAtPeriodEnd: cancelled, purchasedCredits,
      webSubscription: { active: web || overlap, cancelAtPeriodEnd: cancelled, expiresAt: "2026-11-25T00:00:00Z" },
      storeSubscriptions: bothStores ? [
        { store: "play_store", productId: "pro:monthly", plan: "Pro", interval: "monthly", expiresAt: "2099-01-01T00:00:00Z", cancelAtPeriodEnd: false },
        { store: "app_store", productId: "apple.pro", plan: "Pro", interval: "monthly", expiresAt: "2099-01-01T00:00:00Z", cancelAtPeriodEnd: false },
      ] : [],
      products: [
        { store: "play_store", productId: "pro:monthly", kind: "subscription", plan: "Pro", interval: "monthly", monthlyCredits: 3000, maxModels: 3 },
        { store: "play_store", productId: "max:monthly", kind: "subscription", plan: "Max", interval: "monthly", monthlyCredits: 10000, maxModels: 5 },
        { store: "play_store", productId: "credits", kind: "credits", packId: "project_1500", credits: 1500 },
      ],
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Privacy & data", exact: true }).click();
  await page.getByRole("button", { name: "Account, export & deletion", exact: true }).click();
  await page.getByRole("button", { name: "Plans & credits", exact: true }).click();
  await expect(page.getByText("Current plan: Pro")).toBeVisible();
  return calls;
}
test("native billing shows store prices, buys credits, upgrades, restores and opens store cancellation", async ({ page }) => {
  const calls = await installBilling(page);
  await expect(page.getByText("A$7.49", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Buy credits", exact: true }).click();
  await expect(page.getByText("Purchased credits: 1,000")).toBeVisible();
  await page.getByRole("button", { name: "Change plan", exact: true }).click();
  await expect.poll(() => calls.filter((c) => c.method === "purchaseStoreProduct").length).toBe(2);
  expect(calls.filter((c) => c.method === "purchaseStoreProduct")[1].options.storeProductChangeInfo).toEqual({ oldProductIdentifier: "pro:monthly", replacementMode: "CHARGE_PRORATED_PRICE" });
  await page.getByRole("button", { name: "Restore purchases", exact: true }).click();
  await expect.poll(() => calls.some((c) => c.method === "restorePurchases")).toBe(true);
  await page.getByRole("button", { name: "Manage or cancel subscription", exact: true }).click();
  await expect.poll(() => calls.some((c) => c.plugin === "Browser" && c.options.url === "https://play.google.com/store/account/subscriptions")).toBe(true);
});
test("web subscribers can cancel renewal inside the app without a second subscription", async ({ page }) => {
  await installBilling(page, true);
  await expect(page.getByRole("button", { name: "Change plan", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel subscription", exact: true }).click();
  await page.getByRole("button", { name: "Confirm cancellation", exact: true }).click();
  await expect(page.getByText("Automatic renewal has been cancelled.", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Access until:/)).toBeVisible();
});
test("billing fits a narrow screen and keeps Free chat accessible", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 }); await installBilling(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Back to account", exact: true }).click();
  await expect(page.getByRole("button", { name: "Export my data", exact: true })).toBeVisible();
});
test("overlapping web and store subscriptions both remain manageable without another purchase", async ({ page }) => {
  await installBilling(page, false, true);
  await expect(page.getByRole("alert")).toContainText("subscriptions with both providers");
  await expect(page.getByRole("button", { name: "Change plan", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel subscription", exact: true }).click();
  await page.getByRole("button", { name: "Confirm cancellation", exact: true }).click();
  await expect(page.getByText("Automatic renewal has been cancelled.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage or cancel subscription", exact: true })).toBeEnabled();
});
test("both stores expose cancellation when paid subscriptions overlap across devices", async ({ page }) => {
  const calls = await installBilling(page, false, false, true);
  await expect(page.getByRole("button", { name: "Manage or cancel subscription", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Manage App Store subscription", exact: true }).click();
  await expect.poll(() => calls.some((c) => c.plugin === "Browser" && c.options.url === "https://apps.apple.com/account/subscriptions")).toBe(true);
});

test("a pending store payment keeps further subscription purchases disabled after refresh", async ({ page }) => {
  const calls = await installBilling(page, false, false, false, true);
  await page.getByRole("button", { name: "Change plan", exact: true }).click();
  await expect(page.getByText(/A subscription request is awaiting store verification/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Change plan", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh balance", exact: true }).click();
  await expect(page.getByRole("button", { name: "Change plan", exact: true })).toBeDisabled();
  expect(calls.filter((call) => call.method === "purchaseStoreProduct")).toHaveLength(1);
});
