import { expect, test } from "@playwright/test";
import { chatAttachmentExtensionsByGroup } from "../../lib/chatAttachmentFormats";

test("file analysis lists actual supported extensions and model input caveats", async ({ page, isMobile }) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1440, height: 900 });
  await page.goto("/ai-for-file-analysis?lang=en");
  const section = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Prepare files for better results", exact: true }) });
  if (isMobile) {
    const groups = section.getByTestId("attachment-format-details");
    await expect(groups).toHaveCount(6);
    for (const group of await groups.all()) {
      await expect(group).not.toHaveAttribute("open");
      await expect(group.locator("p")).toBeHidden();
      const summary = group.locator("summary");
      await expect(summary).toContainText("See all formats");
      await summary.focus(); await page.keyboard.press("Enter");
      await expect(group).toHaveAttribute("open", "");
      await expect(group.locator("p")).toBeVisible();
    }
  } else {
    await expect(section.getByRole("listitem")).toHaveCount(6);
  }
  const text = await section.innerText();
  for (const extension of Object.values(chatAttachmentExtensionsByGroup()).flat()) expect(text).toContain(`.${extension}`);
  await expect(section).toContainText("Choose an image-capable model for image attachments.");
  await expect(section).toContainText("does not mean every model supports the original file natively");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
