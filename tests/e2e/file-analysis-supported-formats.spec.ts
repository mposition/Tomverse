import { expect, test } from "@playwright/test";
import { chatAttachmentExtensionsByGroup } from "../../lib/chatAttachmentFormats";

test("file analysis lists actual supported extensions and model input caveats", async ({ page }) => {
  await page.goto("/ai-for-file-analysis?lang=en");
  const section = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Prepare files for better results", exact: true }) });
  await expect(section.getByRole("listitem")).toHaveCount(6);
  const text = await section.innerText();
  for (const extension of Object.values(chatAttachmentExtensionsByGroup()).flat()) expect(text).toContain(`.${extension}`);
  await expect(section).toContainText("Choose an image-capable model for image attachments.");
  await expect(section).toContainText("does not mean every model supports the original file natively");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
