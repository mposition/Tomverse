import { expect, test } from "@playwright/test";

test("Korean support offers a first-screen keyboard shortcut to the form", async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name.includes("mobile") ? 320 : 1440, height: 900 });
  await page.goto("/support?lang=ko");
  const shortcut = page.getByRole("link", { name: "문의 작성하기", exact: true });
  await expect(shortcut).toBeInViewport();
  await shortcut.focus();
  await shortcut.press("Enter");
  await expect(page).toHaveURL(/#support-request-form$/);
  const form = page.locator("#support-request-form");
  await expect(form).toBeFocused();
  const type = form.getByRole("combobox");
  await expect(type).toBeInViewport();
  expect(await type.evaluate((node) => node.getBoundingClientRect().top)).toBeGreaterThanOrEqual(64);
  await page.keyboard.press("Tab");
  await expect(type).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
