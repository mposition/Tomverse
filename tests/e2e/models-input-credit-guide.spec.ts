import { expect, test } from "@playwright/test";
import { INPUT_CREDIT_MULTIPLIERS, getInputCreditMultiplier } from "../../lib/models";

test("model base-credit help matches inclusive input multiplier boundaries", async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name.includes("mobile") ? 320 : 1440, height: 900 });
  await page.goto("/models?lang=en");
  const link = page.locator('a[href="#model-input-credit-guide"]').first();
  await link.focus();
  await page.keyboard.press("Enter");
  const guide = page.locator("#model-input-credit-guide");
  await expect(guide).toBeFocused();
  await expect(guide).toBeInViewport();
  await guide.locator("summary").click();
  const bands = guide.getByTestId("model-input-credit-band");
  await expect(bands).toHaveCount(INPUT_CREDIT_MULTIPLIERS.length + 1);
  await expect(bands.first()).toContainText(`Up to ${INPUT_CREDIT_MULTIPLIERS[0].aboveTokens.toLocaleString("en-US")} tokens`);
  for (const [index, threshold] of INPUT_CREDIT_MULTIPLIERS.entries()) {
    expect(getInputCreditMultiplier(threshold.aboveTokens)).toBe(index === 0 ? 1 : INPUT_CREDIT_MULTIPLIERS[index - 1].multiplier);
    expect(getInputCreditMultiplier(threshold.aboveTokens + 1)).toBe(threshold.multiplier);
    await expect(bands.nth(index + 1)).toContainText(`More than ${threshold.aboveTokens.toLocaleString("en-US")}`);
    await expect(bands.nth(index + 1)).toContainText(`${threshold.multiplier}× base credits`);
  }
  await expect(guide).toContainText("including conversation history, extracted file content and system/tool context");
  await expect(guide).toContainText("rounded up to whole credits per model");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
