import { expect, test } from "@playwright/test";
import { AVAILABLE_MODELS } from "../../lib/models";

test("Korean models compare actual base credits and separate reasoning capability", async ({ page }) => {
  const models = [
    { ...AVAILABLE_MODELS.find((model) => model.id === "gpt-6-luna")!, creditWeight: 3, reasoning: "none" },
    { ...AVAILABLE_MODELS.find((model) => model.id === "claude-opus-4-8")!, creditWeight: 16, reasoning: "high" },
  ];
  await page.route("**/api/models/catalog", (route) => route.fulfill({ json: { models } }));
  await page.goto("/models?lang=ko");
  const cards = page.getByRole("article");
  await expect(cards).toHaveCount(2);
  await expect(page.getByText(/숫자가 클수록 같은 짧은 요청의 기본 비용이 높으며/).filter({ visible: true })).toBeVisible();
  await expect(page.getByText("크레딧 사용 등급", { exact: true })).toHaveCount(0);
  for (const model of models) {
    const card = cards.filter({ has: page.getByRole("heading", { name: model.name, exact: true }) });
    await expect(card.getByTestId("model-page-credit-cost")).toHaveAttribute("aria-label", `짧은 요청의 기본 크레딧: ${model.creditWeight} 크레딧`);
  }
  await expect(cards.filter({ has: page.getByRole("heading", { name: models[1].name, exact: true }) }).getByText("추론", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
