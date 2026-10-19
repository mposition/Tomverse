import { expect, test, type Page } from "@playwright/test";

/**
 * AMUX Decision Maker requests that wait on a person are judged in
 * AMUX › Execution (docs/ui-contracts/admin-console-ia.md, "Decision Maker
 * requests are judged in Execution"), and the console has its own Light theme
 * ("The console theme"). The fixture supplies two waiting requests and one
 * escalated card.
 */

const lanes = ["tomverse_backlog", "amux_backlog", "todo", "in_progress", "in_review", "attention"];
const escalated = { id: "qa-task-201", title: "Adjust log retention", sourceKey: "AMUX-201", status: "blocked",
  priority: "p2", kind: "code", cardType: "task", storyKind: null, parentFeatureNodeId: null, parentStoryCardId: null,
  taskRole: "impl", executionGrade: "standard", worker: "claude-impl", lane: null, sev1: false, score: 60,
  scoreFresh: true, dependencyCount: 0, progress: null, briefPresent: true, attentionReason: "human_review_required",
  updatedAt: "2026-10-19T05:00:00Z" };

async function board(page: Page) {
  await page.route("**/api/admin/amux/execution-view?**", async (route) => {
    const view = new URL(route.request().url()).searchParams.get("view");
    if (view === "activation") return route.fulfill({ json: { asOf: "2026-10-19T05:00:00Z", activationAuthorized: false, stages: [] } });
    if (view === "board_snapshot") return route.fulfill({ json: {
      pageSize: 8,
      counts: { tomverse_backlog: 0, amux_backlog: 0, todo: 0, in_progress: 0, in_review: 0, attention: 1, archive: 0 },
      lanes: lanes.map((lane) => ({ lane, cards: lane === "attention" ? [escalated] : [] })),
    } });
    return route.fulfill({ json: { cards: [], counts: {} } });
  });
  await page.goto("/e2e/admin-console-fixture?view=amux&dm=sample");
  await expect(page.getByTestId("amux-board-card-" + escalated.id)).toBeVisible();
}

test("the attention lane holds the waiting requests above the escalated card, and the summary counts both", async ({ page }) => {
  await board(page);
  const summary = page.getByTestId("amux-attention-summary");
  await expect(summary).toContainText("3 waiting on you");
  await expect(summary).toContainText("Decision Maker 2");
  await expect(summary).toContainText("Card reviews 1");

  const lane = page.locator('[data-amux-lane="attention"]');
  await expect(lane.getByRole("heading", { level: 3 })).toContainText("3");
  const requests = lane.getByTestId("amux-dm-attention-list").getByRole("link");
  await expect(requests).toHaveCount(2);
  await expect(requests.nth(0)).toHaveAttribute("data-kind", "proposal");
  await expect(requests.nth(0)).toContainText("Irreversible");
  await expect(requests.nth(1)).toHaveAttribute("data-kind", "delivery_unknown");
  await expect(requests.nth(0)).toHaveAttribute("href", /\/admin\/amux-execution\?tab=cards&dmRequest=/);
  // The requests come before the escalated card.
  const listBox = await lane.getByTestId("amux-dm-attention-list").boundingBox();
  const cardBox = await page.getByTestId("amux-board-card-" + escalated.id).boundingBox();
  expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(cardBox!.y);

  // The summary's jump moves focus to the lane.
  await summary.getByRole("button").click();
  await expect(lane).toBeFocused();
});

test("a request opens as a modal side panel with the judgment pinned to its foot, and Escape closes it", async ({ page }) => {
  await page.goto("/e2e/admin-console-fixture?view=dm&drawer=open");
  const dialog = page.getByRole("dialog", { name: "CR-7, revision 2" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("amux-dm-detail-irreversible")).toBeVisible();
  await expect(dialog.locator('[data-chosen="true"]')).toContainText("Keep one file");
  for (const kind of ["confirm", "edit_confirm", "reject"]) {
    const button = dialog.getByTestId(`amux-dm-judgment-${kind}`);
    await expect(button).toBeVisible();
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  // The action bar stays on screen while the body scrolls.
  const viewport = page.viewportSize()!;
  expect((await dialog.getByTestId("amux-dm-judgment-confirm").boundingBox())!.y).toBeLessThan(viewport.height);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/view=dm$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the console theme is chosen in the account menu, kept in its own cookie, and leaves the product theme alone", async ({ page }) => {
  await page.goto("/e2e/admin-console-fixture?view=dm");
  const shell = page.locator("[data-admin-console]");
  await expect(shell).toHaveAttribute("data-admin-theme", "dark");
  const dark = await shell.evaluate((node) => getComputedStyle(node).backgroundColor);

  await page.getByTestId("admin-account-menu-trigger").click();
  await page.getByTestId("admin-account-menu-theme-light").click();
  await expect(shell).toHaveAttribute("data-admin-theme", "light");
  const light = await shell.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(light).not.toBe(dark);

  const cookies = await page.context().cookies();
  expect(cookies.find((cookie) => cookie.name === "tomverse_admin_theme")?.value).toBe("light");
  expect(cookies.find((cookie) => cookie.name === "tomverse_theme")).toBeUndefined();
});
