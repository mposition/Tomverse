import { expect, test } from "@playwright/test";
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "../../lib/models";
import { mockPublicBillingConfig } from "./support/app-fixtures";

for (const weight of [2, 3]) {
  test(`pricing examples use catalog base cost ${weight} beside plans and packs`, async ({ page }) => {
    await mockPublicBillingConfig(page);
    const model = { ...AVAILABLE_MODELS.find((item) => item.id === DEFAULT_MODEL_ID)!, creditWeight: weight };
    await page.route("**/api/models/catalog", (route) => route.fulfill({ json: { models: [model] } }));
    await page.goto("/pricing?lang=en");
    for (const [id, credits] of [["plan-free", 300], ["plan-pro", 3_000], ["plan-max", 10_000], ["pack-starter_500", 500], ["pack-project_1500", 1_500], ["pack-power_4000", 4_000]] as const) {
      const example = page.getByTestId(`pricing-credit-example-${id}`);
      await expect(example).toContainText(`${credits.toLocaleString("en-US")} credits cover up to ${Math.floor(credits / weight).toLocaleString("en-US")} short text requests with ${model.name} at ${weight} base credits per request.`);
      await expect(example).toContainText("up to 16,000 input tokens, no files, tools or long history");
      await expect(example.getByRole("link")).toHaveAttribute("href", "/models");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("an unavailable example model leaves the cost link without a capacity promise", async ({ page }) => {
  await mockPublicBillingConfig(page);
  await page.route("**/api/models/catalog", (route) => route.fulfill({ json: { models: [] } }));
  await page.goto("/pricing?lang=en");
  await expect(page.getByTestId("pricing-credit-example-plan-pro").getByRole("link")).toBeVisible();
  await expect(page.getByTestId("pricing-credit-example-plan-pro").locator("p")).toHaveCount(0);
});
