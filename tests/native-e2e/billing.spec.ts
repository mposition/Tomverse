import { test, expect, type Page } from "@playwright/test";
import { mobileCopy, type MobileLanguage } from "../../locales/mobile";
import { mobileSettingsCopy } from "../../locales/mobileSettings";
import { mobileBillingCopy, formatMobileBillingCopy } from "../../locales/mobileBilling";

async function installBilling(page: Page, web = false, overlap = false, bothStores = false, pending = false, catalogFails = false, language: MobileLanguage = "en", outcome: "confirmed" | "delayed" | "unchanged" | "cancelled" = "confirmed", passOutcome?: "confirmed" | "expired" | "lost") {
  const calls: { plugin: string; method: string; options: Record<string, unknown> }[] = [];
  await page.exposeFunction("billingCall", (call: typeof calls[number]) => { calls.push(call); });
  await page.addInitScript(({ pending, catalogFails, language, outcome }) => {
    localStorage.setItem("tomverse-language", language);
    localStorage.setItem("tomverse-native-location-consent-v1", JSON.stringify({ offered: true, unclaimedGrant: false, accounts: {} }));
    let catalogAttempts = 0;
    const device = window as unknown as { androidBridge: object; Capacitor: object; billingCall: (call: unknown) => Promise<void> };
    device.androidBridge = {};
    const methods = { MobileAuth: ["hasSession", "getAccessToken", "signIn", "signOut"],
      Purchases: ["configure", "logIn", "getProducts", "purchaseStoreProduct", "restorePurchases"], Browser: ["open"] };
    device.Capacitor = {
      PluginHeaders: Object.entries(methods).map(([name, names]) => ({ name, methods: names.map((name) => ({ name, rtype: "promise" })) })),
      nativePromise: async (plugin: string, method: string, options: Record<string, unknown> = {}) => {
        await device.billingCall({ plugin, method, options });
        if (plugin === "MobileAuth") {
          return method === "hasSession" ? { signedIn: true } : { accessToken: "test-access", expiresAt: Date.now() + 600000 };
        }
        if (method === "getProducts") {
          if (catalogFails && catalogAttempts++ === 0) throw Error("Temporary store outage");
          return { products: (options.productIdentifiers as string[]).map((identifier) => ({ identifier, priceString: identifier === "credits" ? "A$7.49" : identifier.endsWith(":annual") ? "A$280.00" : "A$29.99" })) };
        }
        if (pending && method === "purchaseStoreProduct") throw { code: "20" };
        if (outcome === "cancelled" && method === "purchaseStoreProduct") throw { code: "1" };
        return {};
      },
    };
  }, { pending, catalogFails, language, outcome });
  let purchasedCredits = 500; let cancelled = false;
  let passActivated = false;
  let postPurchaseReads = 0;
  let subscriptionPurchaseAttempt: { id: string; store: string; productId: string; startedAt: string } | null = null;
  await page.route("https://api.native-chat.test/**", async (route) => {
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization,Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/billing/checkout" && passOutcome) {
      expect(route.request().headers().authorization).toBe("Bearer test-access");
      expect(route.request().postDataJSON()).toMatchObject({ planId: "pro", billingInterval: "monthly", promoCode: "TEST-PASS", language });
      if (passOutcome === "lost") return route.abort();
      if (passOutcome === "expired") return route.fulfill({ status: 409, json: { code: "PROMOTION_EXPIRED" }, headers });
      passActivated = true;
      return route.fulfill({ json: { success: true, accessType: "founding_tester_pass", automaticRenewal: false, paymentMethodRequired: false, periodEnd: "2099-01-01T00:00:00Z" }, headers });
    }
    if (path === "/api/user/account") return route.fulfill({ json: { id: "billing-user", name: "Billing user", email: "billing@example.test", actionsEnabled: false }, headers });
    if (path === "/api/conversations") return route.fulfill({ json: [], headers });
    if (path === "/api/models/catalog") return route.fulfill({ json: { models: [] }, headers });
    if (path === "/api/user/usage") return route.fulfill({ json: { plan: "Pro", usage: { creditsMonth: 0 }, limits: { creditsMonth: 3000 } }, headers });
    if (path === "/api/products/chat/capabilities") return route.fulfill({ json: { autoSelection: { offered: false } }, headers });
    if (path !== "/api/mobile/billing") return route.fulfill({ json: {}, headers });
    if (route.request().postDataJSON().action === "cancel_web") cancelled = true;
    if (pending && route.request().postDataJSON().action === "prepare_subscription_purchase") subscriptionPurchaseAttempt = { id: "pending-request", store: "play_store", productId: "max:monthly", startedAt: new Date().toISOString() };
    const purchased = calls.filter(c => c.method === "purchaseStoreProduct");
    const verified = !pending && outcome !== "unchanged" && outcome !== "cancelled" && (outcome !== "delayed" || purchased.length > 0 && ++postPurchaseReads > 1);
    const creditCount = purchased.filter(c => (c.options.product as { identifier: string }).identifier === "credits").length;
    if (verified && creditCount) purchasedCredits = 500 + creditCount * 1500;
    const upgraded = verified && purchased.some(c => (c.options.product as { identifier: string }).identifier === "max:monthly");
    await route.fulfill({ headers, json: {
      billingId: "billing-account", plan: upgraded ? "Max" : "Pro", subscriptionStore: web ? "web" : "play_store", productId: upgraded ? "max:monthly" : "pro:monthly", subscriptionPurchaseAttempt,
      interval: "monthly", expiresAt: "2026-11-25T00:00:00Z", active: true, cancelAtPeriodEnd: cancelled, purchasedCredits,
      promotionPasses: true, accessPass: passActivated ? { expiresAt: "2099-01-01T00:00:00Z" } : null,
      webSubscription: { active: web || overlap, cancelAtPeriodEnd: cancelled, expiresAt: "2026-11-25T00:00:00Z" },
      storeSubscriptions: bothStores ? [
        { store: "play_store", productId: "pro:monthly", plan: "Pro", interval: "monthly", expiresAt: "2099-01-01T00:00:00Z", cancelAtPeriodEnd: false },
        { store: "app_store", productId: "apple.pro", plan: "Pro", interval: "monthly", expiresAt: "2099-01-01T00:00:00Z", cancelAtPeriodEnd: false },
      ] : [],
      products: [
        { store: "play_store", productId: "pro:monthly", kind: "subscription", plan: "Pro", interval: "monthly", monthlyCredits: 3000, maxModels: 3 },
        { store: "play_store", productId: "max:monthly", kind: "subscription", plan: "Max", interval: "monthly", monthlyCredits: 10000, maxModels: 5 },
        { store: "play_store", productId: "pro:annual", kind: "subscription", plan: "Pro", interval: "annual", monthlyCredits: 3000, maxModels: 3 },
        { store: "play_store", productId: "max:annual", kind: "subscription", plan: "Max", interval: "annual", monthlyCredits: 10000, maxModels: 5 },
        { store: "play_store", productId: "credits", kind: "credits", packId: "project_1500", credits: 1500 },
      ],
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: mobileCopy[language].chats, exact: true }).click();
  await page.getByTestId("sidebar-account").getByRole("button", { name: mobileSettingsCopy(language).usageAndPlan, exact: true }).click();
  await expect(page.getByText(formatMobileBillingCopy(mobileBillingCopy(language).currentPlan, { plan: "Pro" }), { exact: true })).toBeVisible();
  return calls;
}
for (const language of ["en", "ko"] as const) test(`native plan applies a Tomverse pass and shows its access period: ${language}`, async ({ page }) => {
  const calls = await installBilling(page, false, false, false, false, false, language, "confirmed", "confirmed");
  const c = mobileBillingCopy(language);
  await page.getByRole("textbox", { name: c.promotionCode, exact: true }).fill("  test-pass  ");
  await page.getByRole("button", { name: c.applyCode, exact: true }).click();
  await expect(page.getByText(c.passApplied, { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: c.promotionCode, exact: true })).toHaveValue("");
  await expect(page.getByText(formatMobileBillingCopy(c.passAccessUntil, { date: new Date("2099-01-01T00:00:00Z").toLocaleDateString(language) }), { exact: true })).toBeVisible();
  expect(calls.filter(call => call.method === "purchaseStoreProduct")).toHaveLength(0);
  await page.screenshot({ path: test.info().outputPath(`promotion-pass-${language}.png`), fullPage: true });
});

for (const outcome of ["expired", "lost"] as const) test(`native pass redemption explains ${outcome} without automatic retries`, async ({ page }) => {
  await installBilling(page, false, false, false, false, false, "ko", "confirmed", outcome);
  let requests = 0;
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/billing/checkout") requests++; });
  const c = mobileBillingCopy("ko");
  await page.getByRole("textbox", { name: c.promotionCode, exact: true }).fill("test-pass");
  await page.getByRole("button", { name: c.applyCode, exact: true }).click();
  await expect(page.getByText(outcome === "expired" ? c.passExpired : c.passUnconfirmed, { exact: true })).toBeVisible();
  await expect(page.getByText(c.passApplied, { exact: true })).toHaveCount(0);
  expect(requests).toBe(1);
});

test("native billing shows store prices, buys credits, upgrades, restores and opens store cancellation", async ({ page }) => {
  const calls = await installBilling(page);
  await expect(page.getByText("A$7.49", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Buy credits", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "1,500 credits added" });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Done", exact: true })).toBeFocused();
  await confirmation.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByText("Purchased credits: 2,000")).toBeVisible();
  await page.getByRole("button", { name: "Change plan", exact: true }).click();
  await expect.poll(() => calls.filter((c) => c.method === "purchaseStoreProduct").length).toBe(2);
  expect(calls.filter((c) => c.method === "purchaseStoreProduct")[1].options.storeProductChangeInfo).toEqual({ oldProductIdentifier: "pro:monthly", replacementMode: "CHARGE_PRORATED_PRICE" });
  await expect(page.getByRole("dialog", { name: "You're subscribed to Max" })).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Restore purchases", exact: true }).click();
  await expect.poll(() => calls.some((c) => c.method === "restorePurchases")).toBe(true);
  await page.getByRole("button", { name: "Manage or cancel subscription", exact: true }).click();
  await expect.poll(() => calls.some((c) => c.plugin === "Browser" && c.options.url === "https://play.google.com/store/account/subscriptions")).toBe(true);
});

test("plan cards use the store's annual price and preserve subscription eligibility", async ({ page }) => {
  const calls = await installBilling(page);
  await page.getByRole("button", { name: "Annual", exact: true }).click();
  const cards = page.locator(".native-billing-plans article");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("A$280.00");
  await expect(cards.nth(0)).toContainText("/ year");
  await expect(cards.nth(1).getByRole("button", { name: "Change plan", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Monthly", exact: true }).click();
  await expect(cards.nth(1).getByRole("button", { name: "Change plan", exact: true })).toBeEnabled();
  expect(calls.filter(call => call.method === "purchaseStoreProduct")).toHaveLength(0);
});

test("a delayed credit update shows verification first and confirms without another purchase", async ({ page }) => {
  const calls = await installBilling(page, false, false, false, false, false, "ko", "delayed");
  await page.getByRole("button", { name: "크레딧 구매", exact: true }).click();
  await expect(page.getByText("결제 내용을 확인하고 있어요", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "1,500 크레딧이 충전되었습니다" })).toBeVisible({ timeout: 12000 });
  await page.getByRole("button", { name: "확인", exact: true }).click();
  await expect(page.getByText("구매한 크레딧: 2,000")).toBeVisible();
  expect(calls.filter(c => c.method === "purchaseStoreProduct")).toHaveLength(1);
});

test("a delayed subscription is announced only after the matching plan is active", async ({ page }) => {
  const calls = await installBilling(page, false, false, false, false, false, "ko", "delayed");
  await page.getByRole("button", { name: "플랜 변경", exact: true }).click();
  await expect(page.getByText("결제 내용을 확인하고 있어요", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Max 플랜에 가입되었습니다" })).toBeVisible({ timeout: 12000 });
  await page.getByRole("button", { name: "확인", exact: true }).click();
  await expect(page.getByText("현재 플랜: Max", { exact: true })).toBeVisible();
  expect(calls.filter(c => c.method === "purchaseStoreProduct")).toHaveLength(1);
});

for (const outcome of ["unchanged", "cancelled"] as const) test(`a ${outcome} payment cannot show a success dialog`, async ({ page }) => {
  await installBilling(page, false, false, false, false, false, "en", outcome);
  await page.getByRole("button", { name: "Buy credits", exact: true }).click();
  if (outcome === "unchanged") {
    await expect(page.getByText("Confirming your purchase", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Refresh balance", exact: true }).click();
  }
  await expect(page.locator(".purchase-confirmation")).toHaveCount(0);
  await expect(page.getByText("Purchased credits: 500", { exact: true })).toBeVisible();
});

for (const theme of ["light", "dark"] as const) test(`purchase confirmation uses ${theme} theme and fits a narrow viewport`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.addInitScript(theme => localStorage.setItem("tomverse-theme", theme), theme);
  await installBilling(page, false, false, false, false, false, "ko");
  await page.getByRole("button", { name: "크레딧 구매", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "1,500 크레딧이 충전되었습니다" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "확인", exact: true })).toBeInViewport();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: test.info().outputPath(`purchase-${theme}.png`) });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("a store catalog failure retains plans and recovers prices without starting a purchase", async ({ page }) => {
  const calls = await installBilling(page, false, false, false, false, true);
  await expect(page.getByRole("alert")).toContainText("Products could not be loaded from Google Play");
  await expect(page.getByRole("heading", { name: "Max", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Buy credits", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("A$7.49", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Buy credits", exact: true })).toBeEnabled();
  expect(calls.filter(call => call.method === "configure")).toHaveLength(1);
  expect(calls.filter(call => call.method === "logIn").length).toBeGreaterThan(0);
  expect(calls.filter(call => call.method === "purchaseStoreProduct")).toHaveLength(0);
});

test("the account menu opens the same plan tab in one tap", async ({ page }) => {
  await installBilling(page);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await page.getByTestId("sidebar-account").getByRole("button", { name: "Usage & plan", exact: true }).click();
  await expect(page.getByTestId("native-settings-tab-plan")).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Current plan: Pro")).toBeVisible();
});

test("web-managed settings keep their web locations on the configured environment", async ({ page }) => {
  const calls = await installBilling(page);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await page.getByTestId("sidebar-account").getByRole("button", { name: "Settings", exact: true }).click();
  const opened = (path: string) => expect.poll(() => calls.some(call => call.plugin === "Browser" && call.options.url === `https://api.native-chat.test${path}`)).toBe(true);
  await page.getByRole("button", { name: "Email notifications", exact: true }).click();
  await opened("/settings/notifications");
  await page.getByTestId("native-settings-tab-assistants").click();
  await page.getByRole("button", { name: "Manage on website", exact: true }).click();
  await opened("/settings/assistants");
  await page.getByTestId("native-settings-tab-ai").click();
  await page.getByRole("button", { name: "Account memory", exact: true }).click();
  await page.getByRole("button", { name: "Manage on website", exact: true }).click();
  await opened("/settings/memory");
  await page.getByRole("button", { name: "Back to settings", exact: true }).click();
  await page.getByTestId("native-settings-tab-data").click();
  await page.getByRole("button", { name: "Import from another AI service", exact: true }).click();
  await opened("/settings/imports");
  await page.getByRole("button", { name: "Your account data", exact: true }).click();
  await page.getByRole("button", { name: "Manage on website", exact: true }).click();
  await opened("/settings/data");
  expect(calls.filter(call => call.method === "purchaseStoreProduct")).toHaveLength(0);
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
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("textbox")).toBeVisible();
  await expect(page.locator(".app-header .icon-logo")).toBeVisible();
  await expect(page.locator(".app-header .wordmark")).toBeVisible();
  await expect(page.locator(".app-header").getByRole("button", { name: "Usage & plan", exact: true })).toHaveCount(0);
  expect(await page.locator(".app-header").evaluate(node => {
    const items = [...node.querySelectorAll(".menu-button,.icon-logo,.wordmark,.product-switcher,.header-new-chat")].map(item => item.getBoundingClientRect());
    return items.every((item, index) => item.width > 0 && (index === 0 || items[index - 1].right <= item.left + 1));
  })).toBe(true);
  await page.screenshot({ path: test.info().outputPath("header-320.png") });
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await expect(page.getByTestId("sidebar-account").getByRole("button", { name: "Usage & plan", exact: true })).toBeInViewport();
});

for (const [language, title, choose, buy, monthly, annual] of [
  ["en", "Plans & credits", "Choose a plan", "Buy credits", "Monthly", "Annual"],
  ["ko", "플랜 및 크레딧", "플랜 선택", "크레딧 구매", "월간", "연간"],
  ["zh", "套餐与积分", "选择套餐", "购买积分", "月付", "年付"],
  ["de", "Tarife & Credits", "Tarif auswählen", "Credits kaufen", "Monatlich", "Jährlich"],
  ["fr", "Offres et crédits", "Choisir une offre", "Acheter des crédits", "Mensuel", "Annuel"],
  ["es", "Planes y créditos", "Elegir un plan", "Comprar créditos", "Mensual", "Anual"],
  ["pt", "Planos e créditos", "Escolher um plano", "Comprar créditos", "Mensal", "Anual"],
] as const) test(`plan content follows the selected app language ${language}`, async ({ page }) => {
  await installBilling(page, false, false, false, false, false, language);
  const panel = page.getByTestId("native-billing");
  await expect(panel.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(panel.getByRole("heading", { name: choose, exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: buy, exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: monthly, exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: annual, exact: true })).toBeVisible();
  await expect(panel.getByText("A$7.49", { exact: true })).toBeVisible();
  if (language === "ko") await page.screenshot({ path: test.info().outputPath("plan-korean.png") });
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
