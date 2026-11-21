import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import { cursorGuideContent } from "@/components/marketing/v2/cursor/cursorGuideContent";

// Cursor connection guide (/developers/cursor, Figma draft approved 2026-11-21): it
// opens with its title and key action, the model table loads from the catalogue with
// Smart Adaptive first, search narrows it, and nothing overflows a 320px phone.
test.setTimeout(90_000);

const pages = [
  { lang: "en", path: "/developers/cursor" },
  { lang: "ko", path: "/ko/developers/cursor" },
] as const;

for (const { lang, path } of pages) {
  test(`${lang} Cursor guide opens with its title, key action and model table`, async ({ page }) => {
    await prepareGuestPage(page, lang);
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    const copy = cursorGuideContent[lang];
    await expect(page.getByTestId("cursor-guide-page")).toBeVisible();
    await expect(page.getByTestId("cursor-guide-title")).toHaveText(copy.hero.title);
    await expect(page.getByTestId("cursor-guide-primary-cta")).toHaveAttribute("href", "/settings/api");
    for (const id of ["before", "step-key", "step-cursor", "step-model", "routing", "models", "verify", "troubleshooting"]) {
      await expect(page.locator(`#${id}`)).toHaveCount(1);
    }
    const table = page.getByTestId("cursor-guide-models");
    await expect(table).toHaveAttribute("aria-busy", "false");
    await expect(page.getByTestId("cursor-guide-model-row").first()).toContainText("smart-adaptive");
  });

  test(`${lang} Cursor guide does not overflow a 320px phone`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, lang);
    await page.goto(path);
    await expect(page.getByTestId("cursor-guide-title")).toBeVisible();
    await page.locator("#models").scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
    await page.locator("#troubleshooting").scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
  });
}

test("searching the model table narrows it and an unknown name says so", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/developers/cursor");
  const copy = cursorGuideContent.en;
  await expect(page.getByTestId("cursor-guide-models")).toHaveAttribute("aria-busy", "false");
  const search = page.getByTestId("cursor-guide-model-search");
  await search.fill("smart-adaptive");
  await expect(page.getByTestId("cursor-guide-model-row")).toHaveCount(1);
  await search.fill("no-such-model-xyz");
  await expect(page.getByTestId("cursor-guide-model-row")).toHaveCount(0);
  await expect(page.getByTestId("cursor-guide-models")).toContainText(copy.models.empty);
});

test("the developer page links to the Cursor guide", async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await page.goto("/ko/developers");
  await expect(page.getByTestId("developers-cursor-guide-link")).toHaveAttribute("href", "/ko/developers/cursor");
});
