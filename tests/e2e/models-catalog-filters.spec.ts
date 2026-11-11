import { expect, test } from "@playwright/test";
import { AVAILABLE_MODELS } from "../../lib/models";
import { prepareGuestPage } from "./support/app-fixtures";

const modelIds = ["gpt-6-luna", "gpt-5-6-terra", "claude-opus-4-8"];
const models = modelIds.map((id) => AVAILABLE_MODELS.find((model) => model.id === id)!);

for (const [locale, labels] of [
  ["ko", { search: "모델명 또는 ID 검색", toggle: "모델 검색·필터", provider: "공급자", plan: "이용할 플랜", clear: "필터 초기화", empty: "조건에 맞는 모델이 없습니다." }],
  ["en", { search: "Search model name or ID", toggle: "Search and filter models", provider: "Provider", plan: "Available with plan", clear: "Clear filters", empty: "No models match these filters." }],
] as const) {
  test(`model filters combine, reset and respect plan access in ${locale}`, async ({ page }, info) => {
    await page.setViewportSize({ width: info.project.name.includes("mobile") ? 320 : 1440, height: 900 });
    await prepareGuestPage(page, locale);
    await page.route("**/api/models/catalog", (route) => route.fulfill({ json: { models } }));
    await page.goto(`/models?lang=${locale}`);
    const cards = page.locator("article[data-model-id]");
    await expect(cards).toHaveCount(3);
    const mobileFilters = page.getByTestId("models-mobile-filters-toggle");
    const hasDisclosure = await mobileFilters.isVisible();
    if (hasDisclosure) {
      await expect(mobileFilters).toHaveText(labels.toggle);
      await expect(mobileFilters).toHaveAttribute("aria-expanded", "false");
      await mobileFilters.click();
      await expect(mobileFilters).toHaveAttribute("aria-expanded", "true");
    }
    const search = page.getByRole("searchbox", { name: labels.search });
    const provider = page.getByRole("combobox", { name: labels.provider, exact: true });
    const plan = page.getByRole("combobox", { name: labels.plan, exact: true });
    const clear = page.getByRole("button", { name: labels.clear, exact: true });
    await provider.selectOption("anthropic");
    await expect(cards).toHaveCount(1);
    await plan.selectOption("Free");
    await expect(cards).toHaveCount(0);
    await expect(page.getByText(labels.empty, { exact: true })).toBeVisible();
    await clear.focus();
    await clear.press("Enter");
    await expect(cards).toHaveCount(3);
    await search.fill("  GPT-6-LUNA  ");
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute("data-model-id", "gpt-6-luna");
    await search.fill("Terra");
    await expect(cards).toHaveAttribute("data-model-id", "gpt-5-6-terra");
    await search.fill("");
    await plan.selectOption("Free");
    await expect(cards).toHaveCount(2);
    await plan.selectOption("Pro");
    await expect(cards).toHaveCount(3);
    await plan.selectOption("Guest");
    await expect(cards).toHaveCount(1);
    await clear.click();
    await expect(page.getByRole("status")).toContainText("3 / 3");
    if (hasDisclosure) {
      await mobileFilters.focus();
      await mobileFilters.press("Enter");
      await expect(mobileFilters).toHaveAttribute("aria-expanded", "false");
      await expect(search).toBeHidden();
      await mobileFilters.press("Enter");
      await expect(search).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
