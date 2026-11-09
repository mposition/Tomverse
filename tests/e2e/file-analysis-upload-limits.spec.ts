import { expect, test } from "@playwright/test";

test("file analysis separates comparable upload limits from security guidance", async ({ page }) => {
  await page.goto("/ai-for-file-analysis?lang=en");
  const limits = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Upload limits", exact: true }) });
  await expect(limits.getByRole("listitem")).toHaveText([
    "Guest: 1 supported file per message, up to 5 MiB per file and 5 MiB total.",
    "Signed-in account with attachment access: up to 5 files per message, 10 MiB per file and 25 MiB total.",
  ]);
  const security = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Security, retention and provider processing", exact: true }) });
  await expect(security).toContainText("Google Drive requires sign-in.");
  await expect(security).toContainText("selected AI providers process the required file content");
  await expect(security).not.toContainText("MiB");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
