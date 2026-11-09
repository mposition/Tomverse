import { expect, test } from "@playwright/test";
import { chatAttachmentExtensionsByGroup } from "../../lib/chatAttachmentFormats";

test("help centre shows supported extensions and limits without horizontal overflow", async ({ page }) => {
  await page.goto("/support/help-centre?lang=en");
  const section = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Files and Google Drive", exact: true }) });
  await expect(section).toBeVisible();
  const copy = await section.innerText();
  for (const extension of Object.values(chatAttachmentExtensionsByGroup()).flat()) {
    expect(copy).toContain(`.${extension}`);
  }
  await expect(section.getByText(/Supported guest formats:/)).toBeVisible();
  await expect(section.getByText(/one file per message, up to 5 MB/)).toBeVisible();
  await expect(section.getByText(/five files, 10 MB each and 25 MB total/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
