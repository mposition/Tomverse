import { expect, test } from "@playwright/test";

test("English support directs screenshot attachments to the existing email channel", async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name.includes("mobile") ? 320 : 1440, height: 900 });
  await page.goto("/support?lang=en");
  await expect(page.getByText("Send screenshot inquiries to support@tomverse.app", { exact: true })).toBeVisible();
  await expect(page.getByText(/This form cannot attach files/)).toBeVisible();
  const email = page.getByTestId("support-screenshot-email");
  await expect(email).toHaveAttribute("href", "mailto:support@tomverse.app");
  await email.focus();
  await expect(email).toBeFocused();
  await expect(page.locator('form input[type="file"]')).toHaveCount(0);
  await expect(page.locator("form").getByRole("button", { name: "Send request", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
