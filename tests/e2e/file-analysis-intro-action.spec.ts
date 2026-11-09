import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

test.setTimeout(90_000);

test("file analysis starts from its introduction using the existing destination", async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name.includes("mobile") ? 320 : 1440, height: 900 });
  await prepareGuestPage(page, "en");
  await page.goto("/ai-for-file-analysis");
  const intro = page.getByTestId("marketing-info-intro-cta");
  const bottom = page.getByRole("link", { name: "Start comparing", exact: true });
  await expect(intro).toHaveAccessibleName("Start analyzing files");
  await expect(intro).toBeInViewport();
  const href = await bottom.getAttribute("href");
  await expect(intro).toHaveAttribute("href", href!);
  await intro.focus();
  await expect(intro).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/review\?lang=en/, { timeout: 30_000 });
  await expect(page.getByTestId("chat-textarea")).toHaveValue("", { timeout: 60_000 });
});
