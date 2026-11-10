import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import { getModel } from "../../lib/models";

test("English model cards retain provider brand casing in rendered text", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: testInfo.project.name.startsWith("mobile") ? 320 : 1440, height: 900 });
  await prepareGuestPage(page, "en");
  await page.goto("/en/models");
  for (const [id, label] of [["gpt-6-luna", "OpenAI"], ["deepseek-v4-flash", "DeepSeek"]]) {
    const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: getModel(id)!.name, exact: true }) });
    const provider = card.getByText(label, { exact: true });
    await expect(provider).toBeVisible({ timeout: 30_000 });
    await expect(provider).toHaveCSS("text-transform", "none");
  }
  await expectNoHorizontalOverflow(page);
});
