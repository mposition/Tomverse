import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";
import { CHAT_WORKSPACE_PATH } from "@/lib/productSurfaceRoutes";

test.setTimeout(90_000);
for (const theme of ["light", "dark"] as const) {
  test(`English home reaches its primary action sooner in ${theme}`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, "en");
    await setDeterministicTheme(page, theme);
    await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL! }]);
    await page.setExtraHTTPHeaders({ "cf-ipcountry": "DE" });
    await page.goto("/?lang=en");
    await expect(page.getByTestId("chat-consent-notice")).toBeVisible({ timeout: 30_000 });
    const action = page.getByTestId("landing-primary-cta");
    await expect(action).toHaveAccessibleName(/Start Chat/);
    await expect(action).toHaveAttribute("href", `${CHAT_WORKSPACE_PATH}?lang=en`);
    await expect(page.getByTestId("launch-review-info-cta")).toHaveAccessibleName(/Explore Review/);
    await expect(page.getByTestId("launch-review-info-cta")).toHaveAttribute("href", "/en/products/review");
    const button = (await action.boundingBox())!;
    expect(button.y + button.height).toBeLessThan(800);
    expect((await page.getByTestId("landing-hero-title").boundingBox())!.height).toBeLessThan(220);
    const details = page.getByTestId("launch-mobile-hero-details");
    await expect(details).toBeVisible();
    expect((await details.boundingBox())!.y).toBeGreaterThan(button.y + button.height);
    await expect(details).toContainText("Smart Adaptive");
    await expect(details).toContainText("AI Review");
    await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("desktop English hero keeps its full introduction before the action", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepareGuestPage(page, "en");
  await page.goto("/en");
  await expect(page.getByTestId("launch-mobile-hero-details")).toBeHidden();
  const intro = page.locator("p").filter({ has: page.locator("span").filter({ hasText: "Use GPT, Claude and Gemini in one place." }) }).first();
  await expect(intro).toBeVisible();
  expect((await intro.boundingBox())!.y).toBeLessThan((await page.getByTestId("landing-primary-cta").boundingBox())!.y);
});

test("mobile hero introduction matches its entry while the session resolves", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await prepareGuestPage(page, "en");
  await page.unroute("**/api/auth/session**");
  let releaseSession!: () => void;
  const sessionReady = new Promise<void>(resolve => { releaseSession = resolve; });
  await page.route("**/api/auth/session**", async route => {
    await sessionReady;
    await route.fulfill({ json: {} });
  });
  try {
    await page.goto("/en");
    const primary = page.getByTestId("landing-primary-cta");
    const introduction = page.locator('[data-testid="launch-homepage"] main section').first().locator("p").first();
    await expect(primary).toHaveAccessibleName(/Start Review/);
    await expect(primary).toHaveAttribute("href", "/review?lang=en");
    await expect(introduction).toContainText("Start with one question in Review.", { useInnerText: true });
    releaseSession();
    await expect(primary).toHaveAccessibleName(/Start Chat/);
    await expect(primary).toHaveAttribute("href", `${CHAT_WORKSPACE_PATH}?lang=en`);
    await expect(introduction).toContainText("Start with one question in Chat.", { useInnerText: true });
  } finally {
    releaseSession();
  }
});

test("versioned landing variant retains its own mobile introduction", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await prepareGuestPage(page, "en");
  await page.addInitScript(() => localStorage.setItem("tomverse_analytics_consent_v1", "accepted"));
  await page.setExtraHTTPHeaders({ "x-e2e-marketing-experiment": "variant", "cf-ipcountry": "DE" });
  await page.context().addCookies([{ name: "tv_exp", value: "e2e-home-hero.home-hero-v1.b.enko", url: baseURL! }]);
  await page.goto("/en/lx/home-hero-v1/b");
  await expect(page.getByText(/^Ask once and read answers from different AI models side by side\./)).toBeVisible();
  await expect(page.getByTestId("launch-mobile-hero-details")).toHaveCount(0);
});
