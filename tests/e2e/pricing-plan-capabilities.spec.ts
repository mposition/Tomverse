import { expect, test } from "@playwright/test";
import { mockPublicBillingConfig } from "./support/app-fixtures";
import { AVAILABLE_MODELS, canUseModelWithPlan, isPubliclySelectableModel } from "../../lib/models";

test("each plan exposes eligible public models and concrete attachment limits", async ({ page }) => {
  await mockPublicBillingConfig(page);
  await page.route("**/api/models/catalog", (route) => route.fulfill({ json: { models: AVAILABLE_MODELS } }));
  await page.goto("/pricing?lang=en");
  for (const plan of ["Free", "Pro", "Max"] as const) {
    const details = page.getByTestId(`pricing-capabilities-${plan.toLowerCase()}`);
    await details.locator("summary").click();
    await expect(details).toHaveAttribute("open", "");
    await expect(details).toContainText("5 files per message, 10 MiB per file and 25 MiB combined");
    await expect(details).toContainText("The app’s input limit and available output space can reduce usable context");
    for (const model of AVAILABLE_MODELS.filter((item) => item.enabled && isPubliclySelectableModel(item))) {
      if (canUseModelWithPlan(plan, model)) {
        await expect(details.locator(`[data-model-id="${model.id}"]`)).toBeVisible();
        await expect(details.locator(`[data-model-id="${model.id}"]`)).toContainText(model.contextWindowTokens ? `${model.contextWindowTokens.toLocaleString("en-US")} tokens` : "context ceiling not listed");
      } else {
        await expect(details.locator(`[data-model-id="${model.id}"]`)).toHaveCount(0);
      }
    }
    await expect(details.getByRole("link", { name: "Compare model access and base credits" })).toHaveAttribute("href", "/models");
    await expect(details.getByRole("link", { name: "File limits and Google Drive help" })).toHaveAttribute("href", "/support/help-centre/chat-workspace?lang=en#files-and-drive");
    await details.locator("summary").click();
    await expect(details).not.toHaveAttribute("open");
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
