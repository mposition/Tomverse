import { expect, test } from "./support/console";
import { adminFixtureDatabase } from "./support/database";

/**
 * Admin › Agent digests: the CI admission line (lib/ciAdmissionCore.ts). The
 * operator reorders waiting pull requests by dragging the handle and from the
 * keyboard; each order is shown at once and saved to the stored state.
 */

const KEY = "ci_admission_state";
const entry = (number: number, base: string, head: string) => ({
  number,
  title: `Pull request ${number}`,
  base,
  head,
  queuedAt: "2026-10-20T01:00:00.000Z",
});
const seed = {
  version: 1,
  capacity: 3,
  queue: [entry(901, "develop", "claude/to-develop/a"), entry(902, "main", "release/2026-10-20-b"), entry(903, "develop", "claude/to-develop/c")],
  released: [],
  events: [{ at: "2026-10-20T01:05:00.000Z", kind: "held", number: 903, shadow: false, detail: "no_slot" }],
  lastRound: { at: "2026-10-20T01:05:00.000Z", used: 2, running: [{ number: 800, title: "Release in flight", base: "main" }] },
};

const storedOrder = async () => {
  const row = await adminFixtureDatabase().appSetting.findUnique({ where: { key: KEY } });
  return row ? (JSON.parse(row.value) as { queue: { number: number }[] }).queue.map((e) => e.number) : [];
};
const shownOrder = (page: import("@playwright/test").Page) =>
  page
    .getByTestId("ci-admission-queue")
    .locator('[data-testid^="ci-admission-row-"]')
    .evaluateAll((rows) => rows.map((row) => Number(row.getAttribute("data-testid")!.split("-").pop())));

test("the operator reorders the line by dragging and from the keyboard, and each order is saved", async ({ page, signInAs }) => {
  await adminFixtureDatabase().appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(seed) },
    update: { value: JSON.stringify(seed) },
  });
  await signInAs("owner");
  await page.goto("/admin/agent-digests?tab=ci-admission");
  // The analytics consent banner sits over the bottom of the page until declined.
  await page.getByRole("button", { name: "Decline", exact: true }).click();

  const section = page.getByTestId("ci-admission-section");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("ci-admission-slots")).toContainText("2 / 3");
  await expect(section.getByTestId("ci-admission-slots")).toContainText("#800 Release in flight");
  expect(await shownOrder(page)).toEqual([901, 902, 903]);
  await page.screenshot({ path: "test-results-admin/ci-admission-dark.png", fullPage: true });

  // Mouse: drag #903 by its handle above #901.
  const handle = section.getByTestId("ci-admission-handle-903");
  await section.getByTestId("ci-admission-queue").scrollIntoViewIfNeeded();
  const from = (await handle.boundingBox())!;
  const top = (await section.getByTestId("ci-admission-row-901").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, top.y + 4, { steps: 12 });
  await expect(section.getByText("Drop here to make it #1")).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => shownOrder(page)).toEqual([903, 901, 902]);
  await expect.poll(storedOrder).toEqual([903, 901, 902]);

  // Keyboard: pick #902 up, move it one place up, drop.
  await section.getByTestId("ci-admission-handle-902").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Space");
  await expect.poll(() => shownOrder(page)).toEqual([903, 902, 901]);
  await expect.poll(storedOrder).toEqual([903, 902, 901]);

  // Escape cancels a keyboard reorder.
  await section.getByTestId("ci-admission-handle-901").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Escape");
  await expect.poll(() => shownOrder(page)).toEqual([903, 902, 901]);

  // Move to top, from the button.
  await section.getByTestId("ci-admission-row-901").getByRole("button", { name: "Move to top" }).click();
  await expect.poll(storedOrder).toEqual([901, 903, 902]);

  // The same section in the Light console theme.
  await page.context().addCookies([{ name: "tomverse_admin_theme", value: "light", url: page.url() }]);
  await page.reload();
  await expect(page.getByTestId("ci-admission-section")).toBeVisible();
  await page.screenshot({ path: "test-results-admin/ci-admission-light.png", fullPage: true });
});
