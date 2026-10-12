import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

const guides = [
  "compare-ai-models",
  "ai-answer-review",
  "chatgpt-vs-claude",
  "ai-for-file-analysis",
] as const;

for (const lang of ["en", "ko"] as const) {
  test(`${lang} separates Review information from both product entry points`, async ({ page }) => {
    await prepareGuestPage(page, lang);
    await page.goto(lang === "en" ? "/" : "/ko");
    await expect(page.getByTestId("landing-hero-title")).toBeVisible();
    await expect(page.getByTestId("landing-primary-cta")).toHaveAttribute(
      "href", `/chat/workspace?lang=${lang}`
    );
    const menuReview = page.getByTestId("header-review-link");
    if (!await menuReview.isVisible()) {
      await page.getByTestId("marketing-menu-button").click();
    }
    const reviewInfo = await menuReview.isVisible() ? menuReview : page.getByTestId("mobile-review-link");
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
