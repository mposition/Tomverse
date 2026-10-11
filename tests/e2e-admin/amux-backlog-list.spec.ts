import { expect, test } from "./support/console";
import { adminFixtureDatabase } from "./support/database";

test("backlog lists four columns, searches all pages and keeps the filter in the URL", async ({ page, signInAs }) => {
  const db = adminFixtureDatabase();
  await db.amuxWorkItem.createMany({ data: Array.from({ length: 52 }, (_, index) => ({
    id: `backlog-list-${index}`, sourceSystem: "test-backlog", sourceKey: `CARD-${index}`,
    title: `Backlog summary ${index}`, status: "backlog", createdAt: new Date(2026, 0, 1, 0, index),
  })) });
  await db.amuxWorkItem.create({ data: { id: "hidden-runnable", sourceKey: "TODO-CARD", title: "Runnable", status: "todo" } });
  await signInAs("owner");
  await page.goto("/admin/amux-backlog");
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  const list = page.getByTestId("amux-backlog-list");
  await expect(list.getByRole("columnheader")).toHaveText(["Card number", "Created", "Summary", "Score"]);
  await expect(list.getByTestId("amux-backlog-row")).toHaveCount(50);
  await page.screenshot({ path: "test-results-admin/backlog-desktop.png" });
  await list.getByRole("link", { name: "Next page" }).click();
  await expect(page).toHaveURL(/tab=list&page=2/);
  await list.getByRole("searchbox", { name: "Search card number" }).fill("card-0");
  await list.getByRole("button", { name: "Search card number" }).click();
  await expect(page).toHaveURL(/tab=list&cardNumber=card-0$/);
  await expect(list.getByTestId("amux-backlog-row")).toHaveCount(1);
  await expect(list.getByTestId("amux-backlog-row")).toContainText("Backlog summary 0");
  await expect(list.getByTestId("amux-backlog-row")).toContainText("Not scored");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(list.getByRole("searchbox")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results-admin/backlog-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await list.getByRole("link", { name: "CARD-0", exact: true }).click();
  await expect(page).toHaveURL(/tab=cards&taskId=backlog-list-0$/);
  await expect(page.getByRole("region", { name: "Task execution detail" })).toContainText("CARD-0");
});

test("old authentication shows a return link without revealing summaries", async ({ page, signInAs }) => {
  await adminFixtureDatabase().amuxWorkItem.create({ data: { id: "private-backlog", title: "Private backlog summary" } });
  await signInAs("owner", { authenticatedMinutesAgo: 45 });
  await page.goto("/admin/amux-backlog");
  await expect(page.getByTestId("amux-backlog-list").getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", /callbackUrl=.*amux-backlog/);
  await expect(page.getByText("Private backlog summary")).toHaveCount(0);
});
