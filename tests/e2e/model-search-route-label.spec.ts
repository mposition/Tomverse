import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, modelMenuTrigger, prepareGuestPage } from "./support/app-fixtures";

test("catalogue shows the actual search supplier without changing model selection", async ({ page }) => {
  test.setTimeout(90_000);
  await prepareGuestPage(page, "en");
  await page.goto("/review");
  await modelMenuTrigger(page).click();
  await page.getByTestId("model-picker-open-all").click();
  const catalogue = page.getByTestId("model-picker-scroll-region");
  await expect(catalogue).toBeVisible({ timeout: 30_000 });
  await expect(catalogue.locator('[data-model-id="gpt-6-luna"]')).toContainText("Web search · Tomverse (Brave)");
  await expect(catalogue.locator('[data-model-id="claude-sonnet-5"]')).toContainText("Web search · Anthropic");
  await expect(catalogue.locator('[data-model-id="gpt-5-6-luna"]')).toContainText("Web search · OpenAI");
  await expectNoHorizontalOverflow(page);
});
