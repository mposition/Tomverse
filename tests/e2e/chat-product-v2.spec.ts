import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { chatPageContent } from "@/components/marketing/v2/chat/chatPageContent";

// The V2 chat introduction page: it loads in both URL forms, shows its title and
// primary action, keeps the header dropdown's section anchors, can be paused and
// does not overflow a 320px phone.
test.setTimeout(90_000);

const pages = [
  { lang: "en", path: "/products/chat" },
  { lang: "ko", path: "/ko/products/chat" },
] as const;

for (const { lang, path } of pages) {
  test(`${lang} chat page opens, keeps its anchors and fits 320px`, async ({ page }) => {
    const copy = chatPageContent[lang];
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, lang);
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);

    const root = page.getByTestId("chat-product-page");
    await expect(root).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("chat-product-title")).toContainText(copy.hero.title[0]);

    // Chat entry when it is offered, otherwise the Chat introduction (this page).
    const primary = page.getByTestId("chat-product-primary-cta");
    await expect(primary).toHaveAccessibleName(copy.hero.primary);
    await expect(primary).toHaveAttribute("href", new RegExp(`(/chat\\?lang=${lang}|/${lang}/products/chat)$`));

    // The header's Chat menu jumps to these sections.
    for (const id of ["continue", "create", "plugins", "mobile"]) {
      await expect(page.locator(`#${id}`)).toHaveCount(1);
    }

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("chat page pauses its motion from the hero button", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/products/chat");
  const root = page.getByTestId("chat-product-page");
  await expect(root).toBeVisible({ timeout: 30_000 });
  const toggle = page.getByTestId("launch-motion-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(root).toHaveAttribute("data-motion", "running");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(root).toHaveAttribute("data-motion", "paused");
});

test("chat page shows a still page when the visitor prefers reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await prepareGuestPage(page, "ko");
  await page.goto("/ko/products/chat");
  const root = page.getByTestId("chat-product-page");
  await expect(root).toBeVisible({ timeout: 30_000 });
  await expect(root).toHaveAttribute("data-motion", "paused");
  await expect(page.getByTestId("launch-motion-toggle")).toHaveCount(0);
});
