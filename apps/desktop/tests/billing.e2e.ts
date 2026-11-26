import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication } from "@playwright/test";

const require = createRequire(import.meta.url);
const executablePath: string = process.env.TOMVERSE_DESKTOP_TEST_ELECTRON ?? require("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));
const authOrigin = process.env.DESKTOP_E2E_AUTH_ORIGIN;

type Host = typeof globalThis & {
  billingEnabled: boolean; plan: "Free" | "Pro" | "Max"; requests: Array<{ method: string; path: string; body: unknown }>;
  checkoutUrl: string; usage(): unknown;
  /** Purchased credits, and how many more usage reads until a late payment adds `landCredits` (0: none pending). */
  purchased: number; landAfterReads: number; landCredits: number;
  accountId: string;
};

test("Desktop plan screen buys, changes and cancels in the app and decides success from the account", {
  timeout: 240_000, skip: !authOrigin,
}, async () => {
  assert.ok(authOrigin);
  const profile = await mkdtemp(join(tmpdir(), "tomverse-billing-"));
  let application: ElectronApplication | undefined;
  try {
    await writeFile(join(profile, "language.txt"), "en");
    application = await electron.launch({ executablePath, args: [desktopDir, `--user-data-dir=${profile}`], timeout: 20_000 });
    await application.evaluate(async ({ app, shell }, { origin }) => {
      const host = globalThis as Host;
      host.billingEnabled = false;
      host.plan = "Free";
      host.requests = [];
      host.checkoutUrl = "https://checkout.stripe.com/c/pay/cs_test_fixture";
      host.purchased = 0;
      host.landAfterReads = 0;
      host.landCredits = 500;
      host.accountId = "billing-account";
      // Stripe is never contacted: every https request from a new session is answered here.
      app.on("session-created", (created) => {
        created.protocol.handle("https", (request) => request.url.startsWith("https://checkout.stripe.com/")
          ? new Response("<!doctype html><title>Pay fixture</title><p>Fixture checkout</p>", { headers: { "content-type": "text/html" } })
          : new Response("", { status: 404 }));
      });
      const realFetch = globalThis.fetch;
      shell.openExternal = async (href) => {
        const target = new URL(href);
        const callback = new URL(target.searchParams.get("redirect_uri")!);
        callback.search = new URLSearchParams({ state: target.searchParams.get("state")!, grant: "a".repeat(43) }).toString();
        if (!(await realFetch(callback)).ok) throw new Error("Unable to connect the test account.");
      };
      // A property, not a named function: evaluated code runs without the test bundler helpers.
      host.usage = () => ({
        plan: host.plan,
        subscription: host.plan === "Free" ? { status: null, billingInterval: null, currentPeriodEnd: null, cancelAtPeriodEnd: false }
          : { status: "active", billingInterval: "monthly", currentPeriodEnd: "2026-12-20T00:00:00.000Z", cancelAtPeriodEnd: false },
        usage: { creditsMonth: 37 }, limits: { creditsMonth: 100 },
        balances: { dailyRemainingCredits: 3, dailyResetsAt: "2026-11-26T00:00:00.000Z", planRemainingCredits: 63,
          planResetsAt: "2026-12-01T00:00:00.000Z", purchasedRemainingCredits: host.purchased, purchasedEarliestExpiry: null },
      });
      globalThis.fetch = async (url, options) => {
        const target = new URL(String(url));
        if (target.origin !== origin) throw new Error("Unexpected Desktop request.");
        const method = options?.method ?? "GET";
        if (target.pathname === "/api/auth/desktop/exchange") {
          return Response.json({ ok: true, accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 600 });
        }
        if (target.pathname === "/api/auth/desktop/session") {
          return Response.json({ ok: true, account: { id: host.accountId, name: "Billing Fixture", email: null } });
        }
        if (target.pathname === "/api/auth/desktop/logout") return Response.json({ ok: true });
        if (target.pathname === "/api/auth/desktop/settings-session") {
          return Response.json({ token: "fixture..billing.web.session", expiresAt: Date.now() + 300_000 });
        }
        if (target.pathname === "/api/products/chat/capabilities") {
          return Response.json({ autoSelection: { offered: false }, desktopBilling: host.billingEnabled });
        }
        if (target.pathname.startsWith("/api/billing/") || target.pathname === "/api/user/usage") {
          const headers = new Headers(options?.headers);
          if (headers.get("cookie") !== "next-auth.session-token=fixture..billing.web.session" || headers.has("authorization")) {
            throw new Error("Billing must use the account settings session.");
          }
          const body = options?.body ? JSON.parse(String(options.body)) : undefined;
          host.requests.push({ method, path: target.pathname + target.search, body });
          if (target.pathname === "/api/user/usage") {
            // A payment the server records late: the balance grows only on a later read.
            if (host.landAfterReads > 0 && --host.landAfterReads === 0) host.purchased += host.landCredits;
            return Response.json(host.usage());
          }
          if (target.pathname === "/api/billing/config") return Response.json({
            plans: [
              { id: "free", name: "Free", monthlyMessageLimit: 300, displayCurrency: "USD", displayMonthlyPriceMinor: 0, displayAnnualPriceMinor: 0 },
              { id: "pro", name: "Pro", monthlyMessageLimit: 3_000, displayCurrency: "USD", displayMonthlyPriceMinor: 1_500,
                displayAnnualPriceMinor: 14_400 },
              { id: "max", name: "Max", monthlyMessageLimit: 10_000, displayCurrency: "USD", displayMonthlyPriceMinor: 2_500,
                displayAnnualPriceMinor: 24_000 },
            ],
            featuredPromotion: null, displayCurrency: "USD", displayCountry: "US",
          });
          if (target.pathname === "/api/billing/credit-packs" && method === "GET") return Response.json({ plan: host.plan, packs: [
            { id: "starter_500", name: "Starter", credits: 500, priceMinor: 500, currency: "USD", validityDays: 90 },
            { id: "project_1500", name: "Project", credits: 1_500, priceMinor: 1_200, currency: "USD", validityDays: 90 },
          ] });
          if (target.pathname === "/api/billing/plan-change" && method === "GET") return Response.json({ reservation: null });
          if (target.pathname === "/api/billing/refund-request" && method === "GET") return Response.json({ pendingRequest: null });
          if (target.pathname === "/api/billing/promotion/validate") return Response.json({ valid: true, promotion: {
            discountPercent: 50, discountAmountCents: null, durationMonths: 1, fulfillmentType: "stripe_subscription",
            accessDurationDays: null, paymentMethodRequired: true, automaticRenewal: true, allowAnnualStacking: false } });
          if (target.pathname === "/api/billing/checkout" || target.pathname === "/api/billing/credit-packs") {
            return Response.json({ url: host.checkoutUrl });
          }
          if (target.pathname === "/api/billing/plan-change/preview") return Response.json({ success: true, quote: {
            requestId: "pcr_fixture", direction: "upgrade", execution: "immediate_upgrade", fromTier: "Pro", toTier: "Max",
            billingInterval: "monthly", currency: "usd", amountDueMinor: 1_000,
            credits: { monthlyPlanCredits: 10_000, remainingPlanCredits: 9_963, overageCredits: 0 },
            effectiveAt: null, renewal: "cancellation_preserved", expiresAt: new Date(Date.now() + 600_000).toISOString() } });
          if (target.pathname === "/api/billing/plan-change/confirm") return Response.json({ success: true, reservation: {
            requestId: "pcr_fixture", direction: "upgrade", execution: "immediate_upgrade", fromTier: "Pro", toTier: "Max",
            billingInterval: "monthly", status: "pending", appliesAt: null, cancellable: false } });
          if (target.pathname === "/api/billing/cancel-subscription") return Response.json({ success: true, cancelAtPeriodEnd: true,
            currentPeriodEnd: "2026-12-20T00:00:00.000Z", status: "active" });
          if (target.pathname === "/api/billing/refund-request") return Response.json({ success: true, requestId: "refund_fixture",
            requestedAt: "2026-11-25T00:00:00.000Z" });
        }
        return Response.json({}, { status: 404 });
      };
    }, { origin: authOrigin });

    const page = await application.firstWindow();
    const rail = page.getByRole("navigation", { name: "Workspaces" });
    const requests = () => application!.evaluate(() => (globalThis as Host).requests.filter(({ path }) => path !== "/api/user/usage"));
    const usageReads = () => application!.evaluate(() => (globalThis as Host).requests.filter(({ path }) => path === "/api/user/usage").length);
    const posts = async (path: string) => (await requests()).filter((request) => request.method === "POST" && request.path === path).length;
    await rail.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Sign in with your browser", exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.desktop.state()).account.stage)).toBe("connected");

    // Switch off: the Plan tab is the balance-only view, and billing calls are refused in the main process.
    const planTab = page.getByTestId("desktop-settings-plan");
    // Signing in from the rail opens Settings; the rail button toggles it.
    const openPlan = async () => {
      if (!(await planTab.isVisible())) await rail.getByRole("button", { name: "Settings", exact: true }).click();
      await planTab.click();
    };
    await openPlan();
    const plan = page.getByTestId("native-account-plan");
    await expect(plan).toContainText("63");
    await expect(plan).not.toHaveAttribute("data-billing", "enabled");
    await expect(page.getByTestId("native-billing-plans")).toHaveCount(0);
    await assert.rejects(page.evaluate(() => window.desktop.billing({ action: "config" })), /unavailable/);
    assert.deepEqual(await requests(), []);

    await application.evaluate(() => { (globalThis as Host).billingEnabled = true; });
    await page.evaluate(() => window.desktop.signOut());
    await page.evaluate(() => window.desktop.signIn());
    await expect.poll(() => page.evaluate(async () => (await window.desktop.state()).capabilities?.billing)).toBe(true);
    await openPlan();
    await expect(page.getByTestId("native-account-plan")).toHaveAttribute("data-billing", "enabled");
    await expect(page.getByTestId("native-billing-balances")).toContainText("63");
    await expect(page.getByTestId("native-billing-plan-pro")).toContainText("$15");

    // Upgrade: the web's order summary and notices, then Stripe in a separate window that never gets the session.
    await page.getByTestId("native-billing-plan-pro").getByRole("button", { name: "Upgrade to Pro" }).click();
    const checkout = page.getByTestId("native-billing-checkout");
    await expect(checkout.getByTestId("native-billing-renewal")).toContainText("renews every month");
    await checkout.getByLabel("Promotion code").fill("tomverse50");
    await checkout.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(checkout.getByTestId("native-billing-promotion")).toContainText("-50%");
    await expect(checkout.getByTestId("native-billing-due")).toHaveText("$7.50");
    await checkout.getByTestId("native-billing-continue").click();
    await expect(page.getByTestId("native-billing-window")).toContainText("checkout.stripe.com");
    // The checkout page is the isolated view inside the separate window.
    const checkoutView = (script: string | null) => application!.evaluate(async ({ BrowserWindow }, script) => {
      const frame = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle().startsWith("checkout.stripe.com"));
      const view = frame?.contentView.children.find((child) => "webContents" in child) as Electron.WebContentsView | undefined;
      if (!frame || !view) return null;
      if (script) { void view.webContents.executeJavaScript(script); return null; }
      return { url: view.webContents.getURL(), title: frame.getTitle(), cookies: await view.webContents.session.cookies.get({}),
        persistent: view.webContents.session.isPersistent(), shared: view.webContents.session === frame.webContents.session,
        globals: await view.webContents.executeJavaScript("[typeof window.desktop, typeof require].join()") };
    }, script);
    await expect.poll(async () => (await checkoutView(null))?.url).toBe("https://checkout.stripe.com/c/pay/cs_test_fixture");
    assert.deepEqual(await checkoutView(null), { url: "https://checkout.stripe.com/c/pay/cs_test_fixture",
      title: "checkout.stripe.com - Tomverse checkout", cookies: [], persistent: false, shared: false, globals: "undefined,undefined" });
    const sent = (await requests()).filter(({ path }) => path === "/api/billing/checkout" || path === "/api/billing/promotion/validate");
    assert.deepEqual(sent.map(({ path, body }) => [path, { ...(body as object), purchaseAttemptId: undefined }]), [
      ["/api/billing/promotion/validate", { planId: "pro", billingInterval: "monthly", promoCode: "TOMVERSE50", currency: "USD",
        purchaseAttemptId: undefined }],
      ["/api/billing/checkout", { planId: "pro", billingInterval: "monthly", language: "en", currency: "USD", promoCode: "TOMVERSE50",
        purchaseAttemptId: undefined }],
    ]);
    // The return page closes the window; only the account the server then reports decides the outcome.
    await checkoutView("location.href = 'https://tomverse.app/chat?billing=success&plan=pro'");
    const verification = page.getByTestId("native-billing-verification");
    await expect(verification).toHaveAttribute("data-stage", "unconfirmed", { timeout: 30_000 });
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    // Starting the subscription again while it is unconfirmed reads the account first and warns before a second checkout.
    const checkouts = await posts("/api/billing/checkout");
    let reads = await usageReads();
    await page.getByTestId("native-billing-plan-pro").getByRole("button", { name: "Upgrade to Pro" }).click();
    await page.getByTestId("native-billing-checkout").getByTestId("native-billing-continue").click();
    await expect(verification).toHaveAttribute("data-stage", "repeat", { timeout: 30_000 });
    await expect(verification).toContainText("A payment you just made may still be processing.");
    await expect(verification.getByRole("button", { name: "Start a new payment anyway" })).toBeVisible();
    assert.ok((await usageReads()) > reads, "the account is read again before the warning");
    assert.equal(await posts("/api/billing/checkout"), checkouts, "no second checkout without the customer's choice");
    await application.evaluate(() => { (globalThis as Host).plan = "Pro"; });
    await verification.getByRole("button", { name: "Check again" }).click();
    await expect(verification).toHaveAttribute("data-stage", "confirmed", { timeout: 30_000 });
    await expect(verification).toContainText("Pro is now active on your account.");
    assert.equal(await posts("/api/billing/checkout"), checkouts);

    // A cancel page is not evidence either: a credit pack the server records on a later read ends confirmed.
    const packs = page.getByTestId("native-billing-credit-packs");
    // The fixture lists Starter (500 credits) first and Project (1,500 credits) second.
    const buy = (index: 0 | 1) => packs.getByRole("button", { name: "Buy", exact: true }).nth(index);
    const checkoutWindow = page.getByTestId("native-billing-window");
    const openPack = async (index: 0 | 1 = 0) => {
      await buy(index).click();
      await expect(checkoutWindow).toContainText("checkout.stripe.com");
      await expect.poll(async () => (await checkoutView(null))?.url).toBe("https://checkout.stripe.com/c/pay/cs_test_fixture");
    };
    const land = (afterReads: number, credits: number) => application!.evaluate((_electron, value) => {
      (globalThis as Host).landAfterReads = value.afterReads;
      (globalThis as Host).landCredits = value.credits;
    }, { afterReads, credits });
    const notice = (item: string) => page.locator(`[data-testid="native-billing-verification"][data-item="${item}"]`);
    const repeatNotice = page.locator('[data-testid="native-billing-verification"][data-stage="repeat"]');
    await openPack();
    reads = await usageReads();
    await land(3, 500);
    await checkoutView("location.href = 'https://tomverse.app/review?billing=credits-cancelled'");
    await expect(verification).toHaveAttribute("data-stage", "confirmed", { timeout: 30_000 });
    await expect(verification).toContainText("Credits added");
    assert.ok((await usageReads()) - reads >= 3, "the account kept being read after the cancel page");

    // A return page that says nothing and an account that never shows the purchase: not confirmed, with a way to check again.
    await openPack();
    reads = await usageReads();
    await checkoutView("location.href = 'https://tomverse.app/review'");
    await expect(verification).toHaveAttribute("data-stage", "unconfirmed", { timeout: 30_000 });
    await expect(verification).toContainText("Tomverse has not recorded this payment yet.");
    await expect(verification).not.toContainText("has not changed");
    await expect(verification.getByRole("button", { name: "Check again" })).toBeVisible();
    assert.ok((await usageReads()) - reads >= 5, "every read is made before the screen says it is not confirmed");

    // Another pack bought meanwhile does not replace Starter's record: Project lands and is confirmed, Starter stays
    // unconfirmed, and buying Starter again still reads the account and warns before a second checkout.
    await openPack(1);
    await land(1, 1_500);
    await checkoutWindow.getByRole("button", { name: "Close checkout window" }).click();
    await expect(page.getByTestId("native-billing-verification").filter({ hasText: "Credits added" })).toBeVisible({ timeout: 30_000 });
    const packPosts = await posts("/api/billing/credit-packs");
    reads = await usageReads();
    await buy(0).click();
    await expect(repeatNotice).toBeVisible({ timeout: 30_000 });
    await expect(repeatNotice).toHaveAttribute("data-item", "credits:starter_500");
    await expect(repeatNotice).toContainText("A payment you just made may still be processing.");
    assert.ok((await usageReads()) > reads, "the account is read again before the warning");
    assert.equal(await posts("/api/billing/credit-packs"), packPosts);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    await expect(notice("credits:project_1500")).toHaveAttribute("data-stage", "confirmed");
    await expect(notice("credits:project_1500")).toContainText("Project");

    // The records live in the main process: another Settings tab and back still shows Starter unconfirmed,
    // and buying it again still warns.
    await page.getByTestId("desktop-settings-account").click();
    await expect(page.getByTestId("native-account-plan")).toHaveCount(0);
    await planTab.click();
    await expect(notice("credits:starter_500")).toHaveAttribute("data-stage", "unconfirmed");
    await expect(notice("credits:starter_500")).toContainText("Tomverse has not recorded this payment yet.");
    await buy(0).click();
    await expect(repeatNotice).toHaveAttribute("data-item", "credits:starter_500", { timeout: 30_000 });
    assert.equal(await posts("/api/billing/credit-packs"), packPosts);

    // A renderer that skips the warning and claims the customer chose to repeat is refused by the main process.
    const skipped = await page.evaluate(() => window.desktop.billing({ action: "buyCreditPack", packId: "starter_500", currency: "USD",
      language: "en", repeatHold: crypto.randomUUID() }));
    assert.equal(skipped.ok && skipped.value.kind, "held");
    assert.equal(await posts("/api/billing/credit-packs"), packPosts);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);

    // The customer's choice in the warning opens the new checkout.
    await buy(0).click();
    await expect(repeatNotice).toBeVisible({ timeout: 30_000 });
    await repeatNotice.getByRole("button", { name: "Start a new payment anyway" }).click();
    await expect(checkoutWindow).toContainText("checkout.stripe.com");
    assert.equal(await posts("/api/billing/credit-packs"), packPosts + 1);

    // Settings closed while the window is open: the window comes back on a return page, the main process still
    // reads the account, and the result is there when the Plan tab opens again.
    await rail.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(planTab).toHaveCount(0);
    reads = await usageReads();
    await expect.poll(async () => (await checkoutView(null))?.url).toBe("https://checkout.stripe.com/c/pay/cs_test_fixture");
    await checkoutView("location.href = 'https://tomverse.app/review'");
    await expect.poll(usageReads, { timeout: 30_000 }).toBeGreaterThanOrEqual(reads + 5);
    await openPlan();
    await expect(notice("credits:starter_500").last()).toHaveAttribute("data-stage", "unconfirmed");
    await expect(notice("credits:starter_500").last()).toContainText("Tomverse has not recorded this payment yet.");

    // The repeat added an attempt and kept the first. Two Starter attempts, and the account shows one pack: one
    // attempt is confirmed, the other stays unconfirmed with its start time, and a third purchase still warns.
    const starterAttempts = (stage: string) =>
      page.locator(`[data-testid="native-billing-verification"][data-item="credits:starter_500"][data-stage="${stage}"]`);
    await land(1, 500);
    await notice("credits:starter_500").last().getByRole("button", { name: "Check again" }).click();
    await expect(starterAttempts("confirmed")).toHaveCount(1, { timeout: 30_000 });
    await expect(starterAttempts("unconfirmed")).toHaveCount(1, { timeout: 30_000 });
    await expect(starterAttempts("unconfirmed")).toContainText("Checkout started");
    const thirdPosts = await posts("/api/billing/credit-packs");
    await buy(0).click();
    await expect(repeatNotice).toHaveAttribute("data-item", "credits:starter_500", { timeout: 30_000 });
    assert.equal(await posts("/api/billing/credit-packs"), thirdPosts, "the third attempt waits for the customer's choice");
    // The same choice is offered beside the pack that was clicked, where the person is looking.
    await expect(packs.getByTestId("native-billing-pack-repeat")).toHaveCount(1);
    await expect(packs.getByTestId("native-billing-pack-repeat-start")).toBeVisible();
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);

    // Another account never sees these records, and its own first purchase of the same pack is not held back.
    await page.evaluate(() => window.desktop.signOut());
    await application.evaluate(() => { (globalThis as Host).accountId = "billing-account-2"; });
    await page.evaluate(() => window.desktop.signIn());
    await expect.poll(() => page.evaluate(async () => (await window.desktop.state()).account.stage)).toBe("connected");
    await openPlan();
    await expect(page.getByTestId("native-billing-balances")).toBeVisible();
    await expect(page.getByTestId("native-billing-verification")).toHaveCount(0);
    assert.deepEqual(await page.evaluate(async () => {
      const result = await window.desktop.billing({ action: "purchases" });
      return result.ok ? result.value.purchases : null;
    }), []);
    await openPack(0);
    assert.equal(await posts("/api/billing/credit-packs"), packPosts + 2);
    await land(1, 500);
    await checkoutWindow.getByRole("button", { name: "Close checkout window" }).click();
    await expect(notice("credits:starter_500")).toHaveAttribute("data-stage", "confirmed", { timeout: 30_000 });
    await expect(notice("credits:starter_500")).toContainText("Credits added");

    // Leaving through Stripe's cancel page says the person did not pay: the record says so, and the next click
    // on the same pack opens a new checkout at once. An attempt whose window was simply closed holds the third.
    const projectAttempts = page.locator('[data-testid="native-billing-verification"][data-item="credits:project_1500"][data-stage="unconfirmed"]');
    await openPack(1);
    await checkoutView("location.href = 'https://tomverse.app/review?billing=credits-cancelled'");
    await expect(projectAttempts).toHaveCount(1, { timeout: 30_000 });
    await expect(projectAttempts).toContainText("It looks like you did not finish paying.");
    const cancelledPosts = await posts("/api/billing/credit-packs");
    await openPack(1);
    assert.equal(await posts("/api/billing/credit-packs"), cancelledPosts + 1);
    await expect(repeatNotice).toHaveCount(0);
    await checkoutWindow.getByRole("button", { name: "Close checkout window" }).click();
    await expect(projectAttempts).toHaveCount(2, { timeout: 30_000 });
    await buy(1).click();
    await expect(repeatNotice).toHaveAttribute("data-item", "credits:project_1500", { timeout: 30_000 });
    assert.equal(await posts("/api/billing/credit-packs"), cancelledPosts + 1);

    // A Checkout URL that is not Stripe's is never opened.
    await application.evaluate(() => { (globalThis as Host).checkoutUrl = "https://checkout.stripe.com.example/c/pay/cs_test"; });
    await buy(0).click();
    await expect(page.getByRole("alert").filter({ hasText: "could not be verified" })).toBeVisible();
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);

    // Plan change: quote, the separate renewal consent, then the confirm with the quoted id.
    await page.getByTestId("native-billing-plan-max").getByRole("button", { name: "Upgrade to Max" }).click();
    const change = page.getByTestId("native-billing-plan-change");
    await expect(change.getByTestId("native-billing-change-amount")).toContainText("$10.00");
    await change.getByTestId("native-billing-resume-renewal").check();
    await change.getByTestId("native-billing-change-confirm").click();
    await expect(change).toHaveAttribute("data-stage", "reserved");
    await expect(change).toContainText("Waiting for your payment");
    await change.getByRole("button", { name: "Back", exact: true }).click();

    // Cancellation takes a second click; a refund request sends the reason.
    const cancel = page.getByTestId("native-billing-cancel").getByRole("button");
    await cancel.click();
    await expect(cancel).toHaveText("Click again to schedule the cancellation.");
    await cancel.click();
    await expect(page.getByTestId("native-billing-cancel").getByRole("status")).toContainText("remain active until");
    const refund = page.getByTestId("native-billing-refund");
    await refund.getByRole("textbox").fill("Charged twice");
    await refund.getByRole("button", { name: "Request refund", exact: true }).click();
    await expect(refund.getByRole("status")).toHaveText("Refund request received.");
    const writes = (await requests()).filter(({ method }) => method !== "GET")
      .filter(({ path }) => !["/api/billing/checkout", "/api/billing/promotion/validate"].includes(path));
    const pack = (packId: string) => ["POST", "/api/billing/credit-packs", { packId, language: "en", currency: "USD" }];
    const starter = pack("starter_500");
    assert.deepEqual(writes.map(({ method, path, body }) => [method, path, body]), [
      starter, starter, pack("project_1500"), starter, starter,
      starter,
      ["POST", "/api/billing/plan-change/preview", { targetTier: "Max", billingInterval: "monthly" }],
      ["POST", "/api/billing/plan-change/confirm", { requestId: "pcr_fixture", resumeRenewal: true }],
      ["POST", "/api/billing/cancel-subscription", {}],
      ["POST", "/api/billing/refund-request", { reason: "Charged twice" }],
    ]);
  } finally {
    await application?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  }
});
