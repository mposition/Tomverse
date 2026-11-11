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
  const table = section.getByRole("table", { name: "Attachment access and limits" });
  await expect(table).toBeVisible();
  const rows = [["Files per message", ["1", "Up to 5"]], ["Per-file size", ["5 MiB", "10 MiB"]], ["Total per message", ["5 MiB", "25 MiB"]], ["Google Drive", ["Unavailable", "Sign-in required"]]] as const;
  for (const [name, values] of rows) {
    const row = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });
    await expect(row.getByRole("cell")).toHaveText([...values]);
  }
  expect((await table.boundingBox())!.y).toBeLessThan((await section.getByRole("listitem").first().boundingBox())!.y);
  await expect(section.getByText(/Supported guest formats:/)).toHaveCount(0);
  expect(copy.match(/\.pdf\b/g)).toHaveLength(1);
  expect(copy.match(/\.json\b/g)).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
