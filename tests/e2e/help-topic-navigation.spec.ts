import { expect, test } from "@playwright/test";

test("help topics navigate to focused headings below the sticky header", async ({ page }) => {
  await page.goto("/support/help-centre?lang=en");
  const nav = page.getByRole("navigation", { name: "Jump to a topic", exact: true });
  await expect(nav.getByRole("link")).toHaveCount(7);
  for (const title of ["Files and Google Drive", "Contact support", "Sign-in and account access"]) {
    const link = nav.getByRole("link", { name: title, exact: true });
    await link.focus();
    await link.press("Enter");
    const id = (await link.getAttribute("href"))!.slice(1);
    await expect(page).toHaveURL(new RegExp(`#${id}$`));
    const section = page.locator(`article[id="${id}"]`);
    await expect(section).toBeFocused();
    const heading = section.getByRole("heading", { name: title, exact: true });
    await expect(heading).toBeVisible();
    await expect(heading).toBeInViewport();
    expect(await heading.evaluate((node) => node.getBoundingClientRect().top)).toBeGreaterThanOrEqual(64);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
