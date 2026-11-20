import { expect, test } from "@playwright/test";
import { modelsPageContent } from "@/components/marketing/v2/models/modelsPageContent";
import { prepareGuestPage } from "./support/app-fixtures";
import { mockModelsCatalog, modelsCatalogFixture } from "./support/models-catalog-fixture";

// A Guest, a Free and a Pro model from three providers.
const ids = ["gpt-6-luna", "deepseek-v4-pro", "claude-opus-5-5"];
const models = ids.map((id) => modelsCatalogFixture.find((model) => model.id === id)!);

for (const locale of ["ko", "en"] as const) {
  const copy = modelsPageContent[locale];
  test(`model filters combine, reset and respect plan access in ${locale}`, async ({ page }, info) => {
    const phone = info.project.name.includes("mobile");
    await page.setViewportSize({ width: phone ? 320 : 1440, height: 900 });
    await prepareGuestPage(page, locale);
    await mockModelsCatalog(page, models);
    await page.goto(`/models?lang=${locale}`);
    const cards = page.locator("article[data-model-id]");
    await expect(cards).toHaveCount(3);
    const toggle = page.getByTestId("models-mobile-filters-toggle");
    const hasDisclosure = await toggle.isVisible();
    if (hasDisclosure) {
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
    }
    const search = page.getByRole("searchbox", { name: copy.list.searchLabel });
    const chip = (row: string, name: string) => page.getByRole("group", { name: row, exact: true }).getByRole("button", { name, exact: true });
    const clear = page.getByRole("button", { name: copy.list.clear, exact: true });

    await chip(copy.list.rows.provider, "DeepSeek").click();
    await expect(cards).toHaveCount(1);
    await chip(copy.list.rows.plan, copy.list.plans.Guest).click();
    await expect(cards).toHaveCount(0);
    await expect(page.getByText(copy.list.empty, { exact: true })).toBeVisible();
    await clear.focus();
    await clear.press("Enter");
    await expect(cards).toHaveCount(3);
    await search.fill("  GPT-6-LUNA  ");
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute("data-model-id", "gpt-6-luna");
    await search.fill("Pro");
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute("data-model-id", "deepseek-v4-pro");
    await search.fill("");
    // The plan chips filter by the plan a model's access starts with.
    await chip(copy.list.rows.plan, copy.list.plans.Free).click();
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute("data-model-id", "deepseek-v4-pro");
    await chip(copy.list.rows.plan, copy.list.plans.Pro).click();
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute("data-model-id", "claude-opus-5-5");
    await chip(copy.list.rows.plan, copy.list.plans.Guest).click();
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute("data-model-id", "gpt-6-luna");
    await clear.click();
    await expect(page.getByRole("status")).toContainText("3 / 3");
    if (hasDisclosure) {
      await toggle.focus();
      await toggle.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator("#models-catalog-filters")).toBeHidden();
      await toggle.press("Enter");
      await expect(page.locator("#models-catalog-filters")).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
