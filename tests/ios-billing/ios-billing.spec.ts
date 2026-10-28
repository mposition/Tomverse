import { test, expect, type Page } from "@playwright/test";
import { mobileSettingsCopy } from "../../locales/mobileSettings";

type Call = { plugin: string; method: string; options: Record<string, unknown> };
type Request = { action: string; store: string; productId?: string; attemptId?: string };
type Attempt = { id: string; store: string; productId: string; startedAt: string };

async function appleBilling(page: Page, outcome: "success" | "pending" | "cancelled" = "success", web = false) {
  const calls: Call[] = [];
  const requests: Request[] = [];
  await page.exposeFunction("iosBillingCall", (call: Call) => { calls.push(call); });
  await page.addInitScript((outcome) => {
    localStorage.setItem("tomverse-native-location-consent-v1", JSON.stringify({ offered: true, unclaimedGrant: false, accounts: {} }));
    const device = window as unknown as { webkit: object; Capacitor: object; iosBillingCall: (call: Call) => Promise<void> };
    device.webkit = { messageHandlers: { bridge: { postMessage: () => {} } } };
    const methods = {
      MobileAuth: ["hasSession", "getAccessToken", "signOut"],
      Purchases: ["configure", "logIn", "getProducts", "purchaseStoreProduct", "restorePurchases"],
      Browser: ["open"],
    };
    device.Capacitor = {
      PluginHeaders: Object.entries(methods).map(([name, names]) => ({ name, methods: names.map(name => ({ name, rtype: "promise" })) })),
      nativePromise: async (plugin: string, method: string, options: Record<string, unknown> = {}) => {
        await device.iosBillingCall({ plugin, method, options });
        if (plugin === "MobileAuth") return method === "hasSession"
          ? { signedIn: true } : { accessToken: "ios-fixture-access", expiresAt: Date.now() + 600000 };
        if (method === "getProducts") return { products: (options.productIdentifiers as string[]).map(identifier => ({
          identifier,
          priceString: identifier.includes("credits") ? "A$7.49" : identifier.endsWith("annual") ? "A$199.99" : "A$19.99",
        })) };
        if (method === "purchaseStoreProduct" && outcome !== "success") throw { code: outcome === "pending" ? "20" : "1" };
        return {};
      },
    };
  }, outcome);

  let purchasedCredits = 500;
  let plan = "Pro";
  let productId = "apple.pro.monthly";
  let subscriptionPurchaseAttempt: Attempt | null = null;
  await page.route("https://api.native-chat.test/**", async route => {
    const headers = {
      "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization,Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/user/account") return route.fulfill({ json: { id: "ios-fixture-user", email: "ios@example.test", actionsEnabled: false }, headers });
    if (path === "/api/conversations") return route.fulfill({ json: [], headers });
    if (path === "/api/models/catalog") return route.fulfill({ json: { models: [] }, headers });
    if (path === "/api/user/usage") return route.fulfill({ json: { plan, usage: { creditsMonth: 0 }, limits: { creditsMonth: 3000 } }, headers });
    if (path === "/api/products/chat/capabilities") return route.fulfill({ json: { autoSelection: { offered: false } }, headers });
    if (path !== "/api/mobile/billing") return route.fulfill({ json: {}, headers });
    const request = route.request().postDataJSON() as Request;
    requests.push(request);
    if (request.action === "prepare_subscription_purchase") subscriptionPurchaseAttempt = {
      id: "ios-attempt", store: "app_store", productId: request.productId!, startedAt: new Date().toISOString(),
    };
    if (request.action === "cancel_subscription_purchase") subscriptionPurchaseAttempt = null;
    return route.fulfill({ headers, json: {
      billingId: "ios-opaque-billing-id", plan, subscriptionStore: web ? "web" : "app_store", productId,
      subscriptionPurchaseAttempt, interval: "monthly", expiresAt: "2099-11-25T00:00:00Z",
      active: true, cancelAtPeriodEnd: false, purchasedCredits,
      webSubscription: { active: web, cancelAtPeriodEnd: false, expiresAt: "2099-11-25T00:00:00Z" },
      products: [
        ...["Pro", "Max"].flatMap(tier => ["monthly", "annual"].map(interval => ({
          store: "app_store", productId: `apple.${tier.toLowerCase()}.${interval}`, kind: "subscription", plan: tier,
          interval, monthlyCredits: tier === "Max" ? 10000 : 3000, maxModels: tier === "Max" ? 5 : 3,
        }))),
        { store: "app_store", productId: "apple.credits1500", kind: "credits", packId: "project_1500", credits: 1500 },
      ],
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await page.getByTestId("sidebar-account").getByRole("button", { name: mobileSettingsCopy("en").usageAndPlan, exact: true }).click();
  await expect(page.getByText("Current plan: Pro")).toBeVisible();
  await expect(page.getByRole("button", { name: "Buy credits", exact: true })).toBeEnabled();
  return {
    calls, requests,
    verifyCredits: () => { purchasedCredits = 2000; },
    verifyUpgrade: () => { plan = "Max"; productId = "apple.max.monthly"; subscriptionPurchaseAttempt = null; },
  };
}

test("iOS configures the Apple SDK with the server identity and loads both product categories", async ({ page }) => {
  const { calls, requests } = await appleBilling(page);
  expect(calls.find(call => call.method === "configure")?.options).toEqual({
    apiKey: "appl_ios_fixture_public_key", appUserID: "ios-opaque-billing-id",
  });
  expect(requests.every(request => request.store === "app_store")).toBe(true);
  const catalog = calls.filter(call => call.method === "getProducts");
  expect(catalog.map(call => call.options.type)).toEqual(["SUBSCRIPTION", "NON_SUBSCRIPTION"]);
  expect(catalog[0].options.productIdentifiers).toContain("apple.max.annual");
  expect(catalog[1].options.productIdentifiers).toEqual(["apple.credits1500"]);
});

test("annual plans show the full localized annual charge and period", async ({ page }) => {
  await appleBilling(page);
  await page.getByRole("button", { name: "Annual", exact: true }).click();
  await expect(page.getByText("A$199.99 / year", { exact: true })).toHaveCount(2);
  await expect(page.getByText("A$19.99 / month", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Subscriptions renew automatically/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Terms of Use", exact: true })).toHaveAttribute("href", "https://tomverse.app/terms");
});

test("an Apple SDK success cannot grant credits before the server verifies payment", async ({ page }) => {
  const fixture = await appleBilling(page);
  await page.getByRole("button", { name: "Buy credits", exact: true }).click();
  await expect(page.locator(".purchase-verifying")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "1,500 credits added", exact: true })).toHaveCount(0);
  await expect(page.getByText("Purchased credits: 500", { exact: true })).toBeVisible();
  expect(fixture.requests.some(request => request.action === "prepare_credit_purchase" && request.productId === "apple.credits1500")).toBe(true);
  expect(fixture.calls.filter(call => call.method === "purchaseStoreProduct")).toHaveLength(1);
  fixture.verifyCredits();
  await page.getByRole("button", { name: "Refresh balance", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "1,500 credits added", exact: true });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Done", exact: true })).toBeFocused();
  await confirmation.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByText("Purchased credits: 2,000", { exact: true })).toBeVisible();
});

test("an iOS upgrade delegates to StoreKit and waits for verified subscription state", async ({ page }) => {
  const fixture = await appleBilling(page);
  await page.getByRole("button", { name: "Change plan", exact: true }).click();
  await expect(page.getByText(/A subscription request is awaiting store verification/)).toBeVisible();
  await expect(page.getByText("Current plan: Pro", { exact: true })).toBeVisible();
  const purchase = fixture.calls.find(call => call.method === "purchaseStoreProduct");
  expect(purchase?.options).toEqual({ product: expect.objectContaining({ identifier: "apple.max.monthly" }) });
  fixture.verifyUpgrade();
  await page.getByRole("button", { name: "Refresh balance", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "You're subscribed to Max", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByText("Current plan: Max", { exact: true })).toBeVisible();
});

test("pending Apple approval keeps another subscription purchase blocked after refresh", async ({ page }) => {
  const { calls, requests } = await appleBilling(page, "pending");
  await page.getByRole("button", { name: "Change plan", exact: true }).click();
  await expect(page.getByText(/Payment is pending approval/)).toBeVisible();
  await page.getByRole("button", { name: "Refresh balance", exact: true }).click();
  await expect(page.getByRole("button", { name: "Change plan", exact: true })).toBeDisabled();
  expect(calls.filter(call => call.method === "purchaseStoreProduct")).toHaveLength(1);
  expect(requests.some(request => request.action === "cancel_subscription_purchase")).toBe(false);
});

test("an explicit StoreKit cancellation releases its subscription attempt", async ({ page }) => {
  const { calls, requests } = await appleBilling(page, "cancelled");
  await page.getByRole("button", { name: "Change plan", exact: true }).click();
  await expect.poll(() => requests.some(request => request.action === "cancel_subscription_purchase" && request.attemptId === "ios-attempt")).toBe(true);
  await expect(page.getByRole("button", { name: "Change plan", exact: true })).toBeEnabled();
  expect(calls.filter(call => call.method === "purchaseStoreProduct")).toHaveLength(1);
  await expect(page.getByText("Current plan: Pro", { exact: true })).toBeVisible();
});

test("iPad layout restores purchases and opens Apple's subscription management", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  const { calls } = await appleBilling(page);
  await page.getByRole("button", { name: "Restore purchases", exact: true }).click();
  await expect(page.getByText(/Purchases restored for this Tomverse account/)).toBeVisible();
  expect(calls.some(call => call.method === "restorePurchases")).toBe(true);
  await page.getByRole("button", { name: "Manage or cancel subscription", exact: true }).click();
  await expect.poll(() => calls.some(call => call.plugin === "Browser" && call.options.url === "https://apps.apple.com/account/subscriptions")).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("an existing web subscription cannot start a second subscription through Apple", async ({ page }) => {
  const { calls } = await appleBilling(page, "success", true);
  await expect(page.getByRole("button", { name: "Change plan", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Buy credits", exact: true })).toBeEnabled();
  expect(calls.some(call => call.method === "purchaseStoreProduct")).toBe(false);
});
