import { expect, test } from "@playwright/test";
import { modelsPageContent } from "@/components/marketing/v2/models/modelsPageContent";
import { mockModelsCatalog } from "./support/models-catalog-fixture";

// English model cards use each model's own catalogue facts, with no invented task
// ranking, and a credit weight of 1 reads "credit" while any other reads "credits".
test("English model choices use individual catalog facts without invented task rankings", async ({ page }, info) => {
  const copy = modelsPageContent.en;
  await page.setViewportSize({ width: info.project.name.includes("mobile") ? 320 : 1440, height: 900 });
  const base = { apiModel: "x", icon: "", bestFor: "", enabled: true, status: "enabled", publiclyListed: true, catalogDeleted: false, usageClass: "advanced" };
  const specs = [
    ["claude-fable-5-2", "Claude Fable 5.2", "anthropic", "Pro"],
    ["claude-haiku-5-5", "Claude Haiku 5.5", "anthropic", "Guest"],
    ["claude-opus-5-5", "Claude Opus 5.5", "anthropic", "Pro"],
    ["gemini-4-flash", "Gemini Flash", "google", "Pro"],
    ["gemini-4-flash-lite", "Gemini Flash-Lite", "google", "Guest"],
    ["mistral-medium-3-5", "Mistral Medium 3.5", "mistral", "Free"],
    ["qwen-3-8-flash", "Qwen 3.8 Flash", "qwen", "Free"],
  ] as const;
  const models = specs.map(([id, name, provider, minimumPlan], index) => ({
    ...base, id, name, provider, minimumPlan, creditWeight: index + 1, reasoning: "none", contextWindowTokens: 128_000 + index,
    inputCapabilities: { image: index !== 0, nativePdf: false },
  }));
  await mockModelsCatalog(page, models);
  await page.goto("/models?lang=en");
  const cards = page.getByRole("article");
  await expect(cards).toHaveCount(models.length);
  for (const [index, model] of models.entries()) {
    const card = cards.filter({ has: page.getByRole("heading", { name: model.name, exact: true }) });
    await expect(card.getByText(copy.list.plans[model.minimumPlan], { exact: true })).toHaveCount(1);
    const unit = copy.list.creditUnit[model.creditWeight === 1 ? 0 : 1];
    await expect(card.getByTestId("model-page-credit-cost")).toHaveAttribute("aria-label", `${copy.list.creditLabel}: ${model.creditWeight} ${unit}`);
    await expect(card.getByText(copy.list.tags.image, { exact: true })).toHaveCount(index === 0 ? 0 : 1);
    for (const label of ["Writing", "Analysis", "Fast"]) await expect(card.getByText(label, { exact: true })).toHaveCount(0);
  }
  // A bigger credit number is a bigger base cost, never a stronger answer.
  await expect(page.getByText(/it is not a performance ranking/).filter({ visible: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
