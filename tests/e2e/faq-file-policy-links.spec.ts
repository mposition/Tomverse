import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import { infoPages } from "../../components/marketing/marketingInfoContent";

test("file-processing FAQ has distinct keyboard-accessible policy links", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await prepareGuestPage(page, "en");
  await page.setViewportSize({ width: testInfo.project.name.startsWith("mobile") ? 320 : 1440, height: 900 });
  await page.goto("/en/faq");
  const answer = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Where are attached files processed?", exact: true }) });
  const safety = answer.getByRole("link", { name: "safety information", exact: true });
  const privacy = answer.getByRole("link", { name: "privacy policy", exact: true });
  await expect(safety).toHaveAttribute("href", "/en/safety");
  await expect(privacy).toHaveAttribute("href", "/privacy");
  for (const link of [safety, privacy]) await expect(link).toHaveCSS("text-decoration-line", "underline");
  await expect(answer.locator("p")).toContainText("See the safety information and privacy policy for current retention and deletion details.");
  await expectNoHorizontalOverflow(page);
  await safety.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/en\/safety$/);
  await expect(page.getByRole("heading", { level: 1, name: infoPages.safety.en.title, exact: true })).toBeVisible();
  await page.goBack();
  await privacy.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy", exact: true })).toBeVisible();
});
