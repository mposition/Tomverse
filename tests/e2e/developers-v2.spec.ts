import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import { developersPageContent } from "@/components/marketing/v2/developers/developersPageContent";

// Developer page V2 (approved concept 2026-11-20): it opens, shows its title and the
// primary action, does not overflow a 320px phone, and the tool tabs work from the keyboard.
test.setTimeout(90_000);

const pages = [
  { lang: "en", path: "/developers" },
  { lang: "ko", path: "/ko/developers" },
] as const;

for (const { lang, path } of pages) {
  test(`${lang} developer page opens with its title and primary action`, async ({ page }) => {
    await prepareGuestPage(page, lang);
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    const copy = developersPageContent[lang];
    await expect(page.getByTestId("developers-page")).toBeVisible();
    await expect(page.getByTestId("developers-title")).toContainText(copy.hero.title[0]);
    const action = page.getByTestId("developers-primary-cta");
    await expect(action).toHaveAccessibleName(new RegExp(copy.hero.primary));
    await expect(action).toHaveAttribute("href", "/settings/api");
    // The header menu jumps to these two sections.
    await expect(page.locator("#connect")).toHaveCount(1);
    await expect(page.locator("#keys")).toHaveCount(1);
  });

  test(`${lang} developer page does not overflow a 320px phone`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, lang);
    await page.goto(path);
    await expect(page.getByTestId("developers-title")).toBeVisible();
    await page.locator("#keys").scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
  });
}

test("the tool tabs change with the arrow keys and stay readable as one tablist", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/developers");
  const codex = page.getByTestId("developers-tool-codex");
  await codex.scrollIntoViewIfNeeded();
  await codex.click();
  await expect(codex).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("developers-console")).toContainText("model_providers.tomverse");
  await page.keyboard.press("ArrowRight");
  const claude = page.getByTestId("developers-tool-claude");
  await expect(claude).toHaveAttribute("aria-selected", "true");
  await expect(claude).toBeFocused();
  await expect(page.getByTestId("developers-console")).toContainText("ANTHROPIC_BASE_URL");
  await page.keyboard.press("End");
  await expect(page.getByTestId("developers-tool-other")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { selected: true })).toHaveCount(1);
});

test("the hero motion control pauses every moving part", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/developers");
  const root = page.getByTestId("developers-page");
  await expect(root).toHaveAttribute("data-motion", "running");
  await page.getByTestId("developers-motion-toggle").click();
  await expect(root).toHaveAttribute("data-motion", "paused");
});
