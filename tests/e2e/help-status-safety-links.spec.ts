import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

test("answer-error and data guidance link to their existing destinations", async ({ page, request }, info) => {
  await page.setViewportSize({ width: info.project.name.includes("mobile") ? 320 : 1440, height: 900 });
  await prepareGuestPage(page, "en");
  await page.goto("/support/help-centre?lang=en");
  for (const item of [
    { title: "When an answer does not arrive", label: "View service status", href: "/status" },
    { title: "Saving, sharing and data", label: "How we handle your data", href: "/en/safety/security-privacy" },
  ]) {
    const article = page.getByRole("article").filter({ has: page.getByRole("heading", { name: item.title, exact: true }) });
    const link = article.getByRole("link", { name: item.label });
    await expect(link).toHaveAttribute("href", item.href);
    await link.focus();
    await expect(link).toBeFocused();
    await expect(link).toBeInViewport();
    expect((await request.get(item.href)).status()).toBe(200);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
