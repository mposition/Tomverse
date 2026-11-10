import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

test("file-analysis introduction and workflow card have distinct useful content", async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name.includes("mobile") ? 320 : 1440, height: 900 });
  await prepareGuestPage(page, "en");
  await page.goto("/ai-for-file-analysis");
  const intro = page.getByRole("heading", { level: 1 }).locator("..").locator("p").nth(1);
  const workflow = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Supported analysis workflows", exact: true }) });
  await expect(intro).toContainText("PDFs, Office documents, text and images");
  expect((await intro.textContent())!.trim()).not.toBe((await workflow.locator("p").textContent())!.trim());
  await expect(workflow.getByRole("listitem")).toHaveCount(3);
  await expect(workflow.getByRole("heading")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
