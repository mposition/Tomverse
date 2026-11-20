import { expect, test } from "@playwright/test";
import { modelsPageContent } from "@/components/marketing/v2/models/modelsPageContent";
import { expectAccessibleContrast } from "./support/ui-audit";
import { prepareGuestPage } from "./support/app-fixtures";
import { mockModelsCatalog, modelsCatalogFixture } from "./support/models-catalog-fixture";

// The longest model name in the fixture, with a Pro plan and a research category.
const model = modelsCatalogFixture.find((item) => item.id === "perplexity-sonar-reasoning-pro")!;

for (const language of ["ko", "en"] as const) for (const width of [320, 1440]) {
  test(`model-card labels are readable, without the internal id, in ${language} at ${width}px`, async ({ page }) => {
    const copy = modelsPageContent[language];
    await page.setViewportSize({ width, height: 900 });
    // Contrast is measured on the settled card, not in the middle of its fade-in.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await prepareGuestPage(page, language);
    await mockModelsCatalog(page, [model]);
    await page.goto(`/models?lang=${language}`);
    const card = page.getByRole("article");
    await expect(card).toHaveCount(1);
    // The card names the model for people; the internal model id is not shown (#4027).
    await expect(card.getByText(model.id, { exact: true })).toHaveCount(0);
    const unit = copy.list.creditUnit[1];
    const fields = [
      { text: model.name, minimum: 14 },
      { text: "Perplexity", minimum: 12 },
      { text: copy.list.plans.Pro, minimum: 11 },
      { text: copy.list.tags.reasoning, minimum: 11 },
      { text: String(model.creditWeight), minimum: 20 },
      { text: unit, minimum: 11 },
    ];
    for (const { text, minimum } of fields) {
      const label = card.getByText(text, { exact: true }).first();
      await expect(label).toBeVisible();
      const metrics = await label.evaluate((node) => ({ font: parseFloat(getComputedStyle(node).fontSize), overflow: node.scrollWidth > node.clientWidth + 1 }));
      expect(metrics.font, text).toBeGreaterThanOrEqual(minimum);
      expect(metrics.overflow, text).toBe(false);
      await expectAccessibleContrast(label, `Model field: ${text}`);
    }
    await expect(card.getByTestId("model-page-credit-cost")).toHaveAccessibleName(`${copy.list.creditLabel}: ${model.creditWeight} ${unit}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
