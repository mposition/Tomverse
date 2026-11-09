import { expect, test } from "@playwright/test";

test("location disclosure separates browser permission and session state", async ({ page }) => {
  await page.goto("/privacy?lang=en");
  const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Optional current location", exact: true }) });
  await expect(section.locator("p")).toHaveCount(4);
  await expect(section).toContainText("Browser or device permission and Tomverse’s location state are separate.");
  await expect(section).toContainText("Reloading alone does not read a position.");
  await expect(section).toContainText("sending a location-dependent question can also trigger an automatic permission request");
  await expect(section).toContainText("blocks further reads and automatic requests for the current session, even if browser permission remains Allow");
  await expect(section).toContainText("Reload or account change resets this suppression");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
