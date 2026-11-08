import { expect, test } from "@playwright/test";
import { INPUT_CREDIT_MULTIPLIERS } from "../../lib/models";
import { NATIVE_ATTACHMENT_ESTIMATED_TOKENS } from "../../lib/chatAttachmentTokens";

test("model base-credit help explains inclusive input multiplier bands", async ({ page }, info) => {
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
    await expect(bands.nth(index + 1)).toContainText(`More than ${threshold.aboveTokens.toLocaleString("en-US")}`);
    await expect(bands.nth(index + 1)).toContainText(`${threshold.multiplier}× base credits`);
  }
  await expect(guide).toContainText("including conversation history, file content and other included request context");
  await expect(guide).toContainText(`${NATIVE_ATTACHMENT_ESTIMATED_TOKENS.toLocaleString("en-US")}-token allowance per file for credit weighting`);
  await expect(guide).toContainText("One such file plus one text token enters the 1.5× band");
  await expect(guide).toContainText("rounded up to whole credits per model");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
