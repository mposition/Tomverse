import { expect, test } from "@playwright/test";
import { modelsPageContent } from "@/components/marketing/v2/models/modelsPageContent";
import { mockModelsCatalog } from "./support/models-catalog-fixture";

test("Korean models compare actual base credits and keep reasoning a separate capability", async ({ page }) => {
  const copy = modelsPageContent.ko;
  const base = { apiModel: "x", icon: "", bestFor: "", enabled: true, status: "enabled", publiclyListed: true, catalogDeleted: false, minimumPlan: "Guest", inputCapabilities: { image: true, nativePdf: false } };
  const models = [
    { ...base, id: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai", usageClass: "standard", creditWeight: 3, reasoning: "none" },
    { ...base, id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic", usageClass: "frontier", creditWeight: 16, reasoning: "high" },
  ];
  await mockModelsCatalog(page, models);
  await page.goto("/models?lang=ko");
  const cards = page.getByRole("article");
  await expect(cards).toHaveCount(2);
  await expect(page.getByText(/숫자가 클수록 같은 짧은 요청의 기본 비용이 높다는 뜻이며/).filter({ visible: true })).toBeVisible();
  for (const model of models) {
    const card = cards.filter({ has: page.getByRole("heading", { name: model.name, exact: true }) });
    await expect(card.getByTestId("model-page-credit-cost")).toHaveAttribute("aria-label", `${copy.list.creditLabel}: ${model.creditWeight} ${copy.list.creditUnit[1]}`);
  }
  // Reasoning is a capability tag on one card, not a cost tier on the other.
  await expect(cards.filter({ has: page.getByRole("heading", { name: models[1].name, exact: true }) }).getByText(copy.list.tags.reasoning, { exact: true })).toBeVisible();
  await expect(cards.filter({ has: page.getByRole("heading", { name: models[0].name, exact: true }) }).getByText(copy.list.tags.reasoning, { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
