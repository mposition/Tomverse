import { expect, test } from "@playwright/test";
import { modelsPageContent } from "@/components/marketing/v2/models/modelsPageContent";
import { mockModelsCatalog } from "./support/models-catalog-fixture";

// Korean model cards show each model's own catalogue facts (plan, image input,
// reasoning, base credits) instead of shared performance claims.
test("Korean model cards use per-model facts instead of shared performance claims", async ({ page }, info) => {
  const copy = modelsPageContent.ko;
  await page.setViewportSize({ width: info.project.name.includes("mobile") ? 320 : 1440, height: 900 });
  const base = { apiModel: "x", icon: "", bestFor: "", enabled: true, status: "enabled", publiclyListed: true, catalogDeleted: false };
  const models = [
    { ...base, id: "claude-fable-5-2", name: "Claude Fable 5.2", provider: "anthropic", minimumPlan: "Pro", usageClass: "apex", creditWeight: 80, reasoning: "high", inputCapabilities: { image: false, nativePdf: false } },
    { ...base, id: "claude-haiku-5-5", name: "Claude Haiku 5.5", provider: "anthropic", minimumPlan: "Guest", usageClass: "standard", creditWeight: 1, reasoning: "none", inputCapabilities: { image: true, nativePdf: false } },
    { ...base, id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic", minimumPlan: "Pro", usageClass: "frontier", creditWeight: 32, reasoning: "high", inputCapabilities: { image: true, nativePdf: false } },
    { ...base, id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic", minimumPlan: "Free", usageClass: "premium-reasoning", creditWeight: 16, reasoning: "none", inputCapabilities: { image: true, nativePdf: false } },
  ];
  await mockModelsCatalog(page, models);
  await page.goto("/models?lang=ko");
  const cards = page.getByRole("article");
  await expect(cards).toHaveCount(4);
  for (const model of models) {
    const card = cards.filter({ has: page.getByRole("heading", { name: model.name, exact: true }) });
    await expect(card.getByText(copy.list.plans[model.minimumPlan as "Guest" | "Free" | "Pro"], { exact: true })).toHaveCount(1);
    await expect(card.getByText(copy.list.tags.image, { exact: true })).toHaveCount(model.inputCapabilities.image ? 1 : 0);
    await expect(card.getByText(copy.list.tags.reasoning, { exact: true })).toHaveCount(model.reasoning === "high" ? 1 : 0);
    await expect(card.getByTestId("model-page-credit-cost")).toHaveAttribute("aria-label", `${copy.list.creditLabel}: ${model.creditWeight} ${copy.list.creditUnit[1]}`);
    await expect(card.getByText("글쓰기", { exact: true })).toHaveCount(0);
    await expect(card.getByText("분석", { exact: true })).toHaveCount(0);
  }
  // The page says a bigger number is a bigger base cost, not a stronger answer.
  await expect(page.getByText(/성능 순위는 아닙니다/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
