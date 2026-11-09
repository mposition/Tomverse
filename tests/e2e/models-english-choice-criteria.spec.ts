import { expect, test } from "@playwright/test";
import { AVAILABLE_MODELS } from "../../lib/models";

test("English model choices use individual catalog facts without invented task rankings", async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name.includes("mobile") ? 320 : 1440, height: 900 });
  const ids = ["claude-fable-5", "claude-haiku-5-5", "claude-opus-4-8", "claude-sonnet-5", "gemini-3-7-flash", "gemini-2-5-flash", "gemini-3-1-pro"];
  const models = ids.map((id, index) => ({ ...AVAILABLE_MODELS.find(model => model.id === id)!, creditWeight: index + 1, contextWindowTokens: index === 0 ? undefined : 128_000 + index, inputCapabilities: { image: index !== 0 } }));
  await page.route("**/api/models/catalog", route => route.fulfill({ json: { models } }));
  await page.goto("/models?lang=en");
  await expect(page.getByTestId("model-selection-criteria")).toHaveCount(models.length);
  for (const [index, model] of models.entries()) {
    const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: model.name, exact: true }) });
    const criteria = card.getByTestId("model-selection-criteria");
    await expect(criteria).toContainText(`Access from: ${model.minimumPlan}`);
    await expect(criteria).toContainText(`Short request: ${model.creditWeight} credits`);
    await expect(criteria).toContainText(`Image input: ${index === 0 ? "not supported" : "supported"}`);
    await expect(criteria).toContainText(`Catalog context maximum: ${model.contextWindowTokens ? `${model.contextWindowTokens.toLocaleString("en-US")} tokens` : "not listed"}`);
    for (const label of ["Writing", "Analysis", "Fast"]) await expect(card.getByText(label, { exact: true })).toHaveCount(0);
  }
  await expect(page.getByText(/higher credit cost does not prove a stronger answer/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
