import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { CHAT_WORKSPACE_PATH } from "@/lib/productSurfaceRoutes";

const guides = [
  "compare-ai-models",
  "ai-answer-review",
  "chatgpt-vs-claude",
  "ai-for-file-analysis",
] as const;

for (const width of [1024, 1100, 1279]) {
  test(`desktop header exposes sign-in without a collapsed menu at ${width}px`, async ({ page }) => {
    await prepareGuestPage(page, "en");
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const header = page.locator("header");
    const login = header.getByRole("link", { name: "Sign in", exact: true });
    await expect(login).toBeVisible();
    await expect(page.getByTestId("marketing-menu-button")).toBeHidden();
    const loginUrl = new URL((await login.getAttribute("href"))!, "https://tomverse.test");
    expect(loginUrl.pathname).toBe("/auth/signin");
    expect(loginUrl.searchParams.get("callbackUrl"))
      .toBe(await page.getByTestId("marketing-header-app-cta").getAttribute("href"));
    const box = await login.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  });
}

test("the generic marketing Review entry stays stable while a session resolves", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.unroute("**/api/auth/session**");
  let releaseSession!: () => void;
  const sessionReady = new Promise<void>(resolve => { releaseSession = resolve; });
  await page.route("**/api/auth/session**", async route => {
    await sessionReady;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "qa-user", name: "QA User", email: "qa@tomverse.app" },
        expires: "2099-01-01T00:00:00.000Z",
      }),
    });
  });
  try {
    await page.goto("/models");
    const cta = page.getByTestId("marketing-header-app-cta");
    await expect(cta).toHaveAttribute("data-session-state", "loading");
    await expect(cta).toHaveAttribute("href", "/review?lang=en");
    releaseSession();
    await expect(cta).toHaveAttribute("data-session-state", "authenticated");
    await expect(cta).toHaveAttribute("href", "/review?lang=en");
    await expect(cta).toHaveText("Back to Review");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("marketing-menu-button").click();
    await expect(page.getByTestId("marketing-mobile-app-cta")).toHaveAttribute("href", "/review?lang=en");
  } finally {
    releaseSession();
  }
});

for (const lang of ["en", "ko"] as const) {
  test(`${lang} separates Review information from the available product entry`, async ({ page }) => {
    await prepareGuestPage(page, lang);
    await page.goto(lang === "en" ? "/" : "/ko");
    await expect(page.getByTestId("landing-hero-title")).toBeVisible();
    await expect(page.getByTestId("marketing-header-app-cta")).toHaveAttribute("data-session-state", "unauthenticated");
    const guestChatAvailable = await page.getByTestId("launch-homepage").getAttribute("data-guest-chat-trial-available") === "true";
    await expect(page.getByTestId("landing-primary-cta")).toHaveAttribute(
      "href", guestChatAvailable ? `${CHAT_WORKSPACE_PATH}?lang=${lang}` : `/review?lang=${lang}&entry=guest-preview`
    );
    const menuReview = page.getByTestId("header-review-link");
    if (!await menuReview.isVisible()) {
      await page.getByTestId("marketing-menu-button").click();
    }
    const reviewInfo = await menuReview.isVisible() ? menuReview : page.getByTestId("mobile-review-link");
    const chatIntro = await menuReview.isVisible() ? page.getByTestId("header-chat-link") : page.getByTestId("mobile-chat-link");
    await expect(chatIntro).toHaveAttribute("href", guestChatAvailable ? `${CHAT_WORKSPACE_PATH}?lang=${lang}` : `/${lang}#chat`);
    await expect(reviewInfo).toHaveAttribute("href", `/${lang}/products/review`);
    await reviewInfo.click();
    await expect(page).toHaveURL(new RegExp(`/${lang}/products/review$`));
    await expect(page.getByTestId("landing-loop-section")).toBeVisible();
    await expect(page.getByTestId("landing-quick-summary-card")).toBeVisible();
    await expect(page.getByTestId("landing-item-verification-card")).toBeVisible();
    await expect(page.getByTestId("landing-primary-cta")).toHaveAttribute(
      "href", `/review?lang=${lang}&entry=guest-preview`
    );
  });
}

test("the homepage footer retains all four Korean guide routes", async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await page.goto("/ko");
  for (const slug of guides) {
    const link = page.locator(`footer a[href='/ko/${slug}']`);
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAccessibleName(/.+/);
  }
  for (const slug of guides) {
    const response = await page.goto(`/ko/${slug}`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("main h1")).toBeVisible();
    const canonical = await page.locator("link[rel='canonical']").getAttribute("href");
    expect(canonical).toBe(`https://tomverse.app/ko/${slug}`);
  }
});

test("Guest Chat either opens its introduction or starts the available workspace without a 404", async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/ko");
  await expect(page.getByTestId("marketing-header-app-cta")).toHaveAttribute("data-session-state", "unauthenticated");
  const guestChatAvailable = await page.getByTestId("launch-homepage").getAttribute("data-guest-chat-trial-available") === "true";
  const chatHref = guestChatAvailable ? `${CHAT_WORKSPACE_PATH}?lang=ko` : "/ko#chat";
  await expect(page.getByTestId("header-chat-link")).toHaveAttribute("href", chatHref);
  await expect(page.locator(`footer a[href='${chatHref}']`)).toHaveText("Tomverse Chat");
  if (!guestChatAvailable) {
    await page.getByTestId("header-chat-link").click();
    await expect(page).toHaveURL(/\/ko#chat$/);
    await expect(page.locator("#chat")).toBeVisible();
  }
  const destination = await page.getByTestId("landing-primary-cta").getAttribute("href");
  expect(destination).toBe(guestChatAvailable ? `${CHAT_WORKSPACE_PATH}?lang=ko` : "/review?lang=ko&entry=guest-preview");
  const destinationUrl = new URL(destination!, "https://tomverse.test");
  const loaded = page.waitForResponse(response => response.request().isNavigationRequest() && new URL(response.url()).pathname === destinationUrl.pathname);
  await page.getByTestId("landing-primary-cta").click();
  expect((await loaded).status()).toBe(200);
  await expect(page).toHaveURL(url => url.pathname === destinationUrl.pathname && url.search === destinationUrl.search);
  await expect(page.getByTestId("landing-hero-title")).toHaveCount(0);
});

test("a missing or unavailable capability keeps authenticated marketing on the Review alternative", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.unroute("**/api/auth/session**");
  await page.route("**/api/auth/session**", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ user: { id: "qa-user", name: "QA User", email: "qa@tomverse.app" }, expires: "2099-01-01T00:00:00.000Z" }),
  }));
  // Keep the actual capability route. This base returns 404; a product build
  // may return a closed offer, but neither is an offered authenticated Chat.
  const read = page.waitForResponse(response => new URL(response.url()).pathname === "/api/products/chat/capabilities");
  await page.goto("/");
  const response = await read;
  if (response.ok()) expect((await response.json()).autoSelection?.offered).toBe(false);
  else expect(response.status()).toBe(404);
  await expect(page.getByTestId("marketing-header-app-cta")).toHaveAttribute("data-session-state", "authenticated");
  await expect(page.getByTestId("marketing-header-app-cta")).toHaveAttribute("href", "/review?lang=en");
  await expect(page.getByTestId("marketing-header-app-cta")).toHaveText("Back to Review");
  await expect(page.getByTestId("header-chat-link")).toHaveAttribute("href", "/en#chat");
});

test("resolving a session preserves the selected example and the mounted hero", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.unroute("**/api/auth/session**");
  let releaseSession!: () => void;
  const sessionReady = new Promise<void>(resolve => { releaseSession = resolve; });
  await page.route("**/api/auth/session**", async route => {
    await sessionReady;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      user: { id: "qa-user", name: "QA User", email: "qa@tomverse.app" }, expires: "2099-01-01T00:00:00.000Z",
    }) });
  });
  try {
    await page.goto("/");
    await expect(page.getByTestId("marketing-header-app-cta")).toHaveAttribute("data-session-state", "loading");
    const title = page.getByTestId("landing-hero-title");
    const originalTitle = await title.elementHandle();
    expect(originalTitle).not.toBeNull();
    const tabs = page.getByTestId("launch-gallery").getByRole("tab");
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    releaseSession();
    await expect(page.getByTestId("marketing-header-app-cta")).toHaveAttribute("data-session-state", "authenticated");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    expect(await title.evaluate((element, original) => element === original, originalTitle)).toBe(true);
  } finally {
    releaseSession();
  }
});

test("everyday examples change their results with keyboard input without calling an AI", async ({ page }) => {
  await prepareGuestPage(page, "en");
  let providerRequests = 0;
  await page.route("**/api/chat", route => {
    providerRequests += 1;
    return route.fulfill({ status: 409, body: "{}" });
  });
  await page.goto("/");
  const gallery = page.getByTestId("launch-gallery");
  const tabs = gallery.getByRole("tab");
  const panel = gallery.getByRole("tabpanel");
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  const travel = await panel.innerText();
  await tabs.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(panel).not.toHaveText(travel, { useInnerText: true });
  const learning = await panel.innerText();
  await page.keyboard.press("End");
  await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
  await expect(panel).not.toHaveText(learning, { useInnerText: true });
  await page.keyboard.press("Home");
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(panel).toHaveText(travel, { useInnerText: true });
  expect(providerRequests).toBe(0);
});

for (const width of [320, 390, 1440]) {
  test(`homepage content remains readable at ${width}px with 200% text scale`, async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/ko");
    await page.evaluate(async () => {
      await document.fonts.ready;
      document.documentElement.style.fontSize = "32px";
    });
    const outside = await page.locator("main").evaluate(main => {
      const viewport = document.documentElement.clientWidth;
      return Array.from(main.querySelectorAll("h1,h2,h3,p,a,button")).filter(node => {
        if (node.closest("[aria-hidden='true']")) return false;
        const box = node.getBoundingClientRect();
        return box.width > 0 && (box.left < -1 || box.right > viewport + 1);
      }).map(node => ({ tag: node.tagName, text: node.textContent?.slice(0, 60) }));
    });
    expect(outside).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width + 1);
  });
}

test("hero motion can be turned off without hiding its content", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const hero = page.locator("section[aria-labelledby='landing-hero-title']");
  const control = page.getByTestId("launch-motion-toggle");
  await expect.poll(() => hero.evaluate(element => element.getAnimations({ subtree: true }).length)).toBeGreaterThan(0);
  await control.click();
  await expect(control).toHaveAttribute("aria-pressed", "true");
  expect(await hero.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(page.getByTestId("landing-hero-title")).toBeVisible();
  await expect(hero.getByRole("heading", { level: 2 })).toBeVisible();
  await control.click();
  await expect(control).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => hero.evaluate(element => element.getAnimations({ subtree: true }).length)).toBeGreaterThan(0);
});

test("the hero headline remains visible for a full cycle after its entrance completes", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const title = page.getByTestId("landing-hero-title");
  await expect(title).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2000);
  const observation = await title.evaluate(async element => {
    const spans = Array.from(element.querySelectorAll(":scope > span"));
    const violations: Array<{ elapsed: number; opacities: string[] }> = [];
    const started = performance.now();
    let samples = 0;
    while (performance.now() - started < 4600) {
      const opacities = spans.map(span => getComputedStyle(span).opacity);
      if (opacities.some(opacity => opacity !== "1")) violations.push({ elapsed: Math.round(performance.now() - started), opacities });
      samples += 1;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { spanCount: spans.length, samples, violations };
  });
  expect(observation.spanCount).toBe(2);
  expect(observation.samples).toBeGreaterThanOrEqual(40);
  expect(observation.violations).toEqual([]);
});

test("reduced motion exposes a complete static hero and local design assets", async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ko");
  await expect(page.getByTestId("landing-primary-cta")).toBeVisible();
  const missing = await page.locator("main img").evaluateAll(images =>
    images.filter(image => !(image as HTMLImageElement).complete || !(image as HTMLImageElement).naturalWidth)
      .map(image => image.getAttribute("src"))
  );
  expect(missing).toEqual([]);
  expect(await page.locator("main").evaluate(main => main.getAnimations({ subtree: true }).length)).toBe(0);
});
