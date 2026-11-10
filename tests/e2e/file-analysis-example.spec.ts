import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";

test("file analysis distinguishes the general feature from a labelled example", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: testInfo.project.name.startsWith("mobile") ? 320 : 1440, height: 900 });
  await prepareGuestPage(page, "en");
  await page.goto("/en/ai-for-file-analysis");
  const intro = page.getByRole("heading", { level: 1, name: "Analyze files with multiple AI models", exact: true }).locator("..").locator("p").last();
  await expect(intro).toContainText("multiple AI models interpret supported PDFs");
  await expect(intro).not.toContainText("club notice");
  const example = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Example: analyze a club notice", exact: true }) });
  await expect(example).toContainText("dates, items to bring and reply deadlines");
  await expect(example).toContainText("supporting sentence");
  await expect(example.getByRole("listitem")).toHaveCount(3);
  await expect(page.getByRole("link", { name: "Start comparing", exact: true }).last()).toHaveAttribute("href", "/review?lang=en");
  await expectNoHorizontalOverflow(page);
});
