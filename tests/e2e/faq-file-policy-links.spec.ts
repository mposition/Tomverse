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
  // Phones collapse FAQ answers behind a toggle (#3602); desktop shows them open.
  const expandOnPhone = async () => {
    const toggle = answer.getByRole("button");
    if (!(await toggle.isVisible())) return;
    await expect(async () => {
      if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
  };
  await expandOnPhone();
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
  await expandOnPhone();
  await privacy.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy", exact: true })).toBeVisible();
});
