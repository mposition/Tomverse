import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { reviewPageContent } from "@/components/marketing/v2/review/reviewPageContent";

// The V2 answer comparison page: it loads in both URL forms, shows its title and
// primary action, keeps the guest preview entry, can be paused and does not
// overflow a 320px phone.
test.setTimeout(90_000);

const pages = [
  { lang: "en", path: "/products/review" },
  { lang: "ko", path: "/ko/products/review" },
] as const;

for (const { lang, path } of pages) {
  test(`${lang} review page opens, keeps its guest entry and fits 320px`, async ({ page }) => {
    const copy = reviewPageContent[lang];
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, lang);
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);

    await expect(page.getByTestId("review-product-page")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("review-product-title")).toContainText(copy.hero.title[0]);

    // A guest enters Review's comparison preview (docs/ui-contracts/chat-product-switcher.md section 3).
    // The experiment beacon and the header's scroll cue look the button up by this id.
    const primary = page.getByTestId("landing-primary-cta");
    await expect(primary).toHaveAttribute("id", "landing-hero-primary");
    await expect(primary).toHaveAccessibleName(copy.hero.primary);
    await expect(primary).toHaveAttribute("href", `/review?lang=${lang}&entry=guest-preview`);

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("review page pauses its motion from the hero button", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/products/review");
  const root = page.getByTestId("review-product-page");
  await expect(root).toBeVisible({ timeout: 30_000 });
  const toggle = page.getByTestId("launch-motion-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(root).toHaveAttribute("data-motion", "running");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(root).toHaveAttribute("data-motion", "paused");
  // The recorded demo stops with it.
  await expect.poll(() => page.locator("main video").evaluateAll((videos) => videos.every((video) => (video as HTMLVideoElement).paused))).toBe(true);
});

test("review page shows a still page when the visitor prefers reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await prepareGuestPage(page, "ko");
  await page.goto("/ko/products/review");
  const root = page.getByTestId("review-product-page");
  await expect(root).toBeVisible({ timeout: 30_000 });
  await expect(root).toHaveAttribute("data-motion", "paused");
  await expect(page.getByTestId("launch-motion-toggle")).toHaveCount(0);
  await expect.poll(() => page.locator("main video").evaluateAll((videos) => videos.every((video) => (video as HTMLVideoElement).paused))).toBe(true);
});
