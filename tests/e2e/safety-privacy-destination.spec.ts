import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { infoPages } from "@/components/marketing/marketingInfoContent";

// The card's first sentence, read from the copy so a wording update cannot leave
// this check asserting a sentence the page no longer has.
const dataHandling = infoPages.safety.en.sections.find(section => section.title === "Security and data handling")!;

test("safety data guidance points to the privacy policy instead of itself", async ({ page, request }, info) => {
  await page.setViewportSize({ width: info.project.name.includes("mobile") ? 320 : 1440, height: 900 });
  await prepareGuestPage(page, "en");
  await page.goto("/safety?lang=en");
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Security and data handling", exact: true }) });
  const link = card.getByRole("link", { name: "Read the privacy policy" });
  await expect(link).toBeVisible({ timeout: 30_000 });
  await expect(card).not.toContainText("See the safety information");
  await expect(card).toContainText(dataHandling.body.split(". ")[0]);
  await expect(link).toHaveAttribute("href", "/privacy");
  await link.focus();
  await expect(link).toBeFocused();
  await expect(link).toBeInViewport();
  expect((await request.get("/privacy")).status()).toBe(200);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
