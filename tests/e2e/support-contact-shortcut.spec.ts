import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

test("contact shortcut focuses the form title before the first field", async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name.includes("mobile") ? 320 : 1440, height: info.project.name.includes("mobile") ? 568 : 900 });
  await prepareGuestPage(page, "en");
  await page.goto("/support?lang=en");
  const jump = page.locator('a[href="#support-request-title"]');
  await expect(jump).toHaveAccessibleName("Contact support");
  await expect(jump).toBeInViewport();
  await expect(jump).toHaveAttribute("href", "#support-request-title");
  const review = page.getByRole("link", { name: "Open Review", exact: true });
  expect(await review.evaluate(node => getComputedStyle(node).textDecorationLine)).toContain("underline");
  let submissions = 0;
  page.on("request", request => { if (request.method() === "POST" && request.url().includes("/api/feedback")) submissions++; });
  await jump.focus();
  await page.keyboard.press("Enter");
  const title = page.locator("#support-request-title");
  await expect(title).toBeFocused();
  await expect(title).toBeInViewport();
  expect((await title.boundingBox())!.y).toBeGreaterThanOrEqual(64);
  await expect(page).toHaveURL(/#support-request-title$/);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("form", { name: "Contact support" }).getByRole("combobox")).toBeFocused();
  expect(submissions).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
