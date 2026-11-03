import { expect, test } from "./support/console";
import { adminFixtureDatabase } from "./support/database";

/**
 * Admin › Agent digests: the CI admission line (lib/ciAdmissionCore.ts). The
 * operator reorders the pull requests in line by dragging the handle and from the
 * keyboard; each order is shown at once and saved to the stored state.
 */

const KEY = "ci_admission_state";
const SHA_901 = "1".repeat(40);
const SHA_903 = "3".repeat(40);
const entry = (number: number, base: string, head: string, headSha = "") => ({
  number,
  title: `Pull request ${number}`,
  base,
  head,
  headSha,
  queuedAt: "2026-10-20T01:00:00.000Z",
  draft: true,
  status: "waiting",
});
const seed = {
  version: 3,
  capacity: 40,
  needs: { develop: 15, main: 34, developPush: 18, mainPush: 19 },
  queue: [
    entry(901, "develop", "claude/to-develop/a", SHA_901),
    entry(902, "main", "release/2026-10-20-b"),
    entry(903, "develop", "claude/to-develop/c", SHA_903),
  ],
  released: [],
  pendingStatus: [],
  events: [{ at: "2026-10-20T01:05:00.000Z", kind: "held", number: 903, shadow: false, detail: "no_slot" }],
  lastRound: {
    at: "2026-10-20T01:05:00.000Z",
    // main 34 + the develop deploy 18.
    used: 52,
    running: [{ number: 800, title: "Release in flight", base: "main" }],
    deploys: [{ branch: "develop", sha: "e".repeat(40), title: "Merge pull request #799 from mposition/claude/to-develop/z" }],
  },
};

// The review server's last status report, with the CI auto-fix's tries
// (lib/ciAdmissionFixCore.ts): #901's head was tried and not fixed, #903's is
// being analysed.
const reviewStatus = () =>
  JSON.stringify({
    receivedAt: new Date().toISOString(),
    snapshot: {
      schemaVersion: 1,
      draining: false,
      pendingJobs: 0,
      providers: [
        { id: "claude", vendor: "anthropic", enabled: true, running: 0, maxConcurrent: 1, quota: { state: "available", remaining: 64, unit: "percent" } },
      ],
      last24h: { accept: 0, reject: 0, unknown: 0 },
      ciFix: {
        queuedLastHour: 2,
        entries: [
          { pr: 903, head: SHA_903, kind: "ci", outcome: "started", reason: null, retried: false, ageSeconds: 60 },
          { pr: 901, head: SHA_901, kind: "ci", outcome: "no_change", reason: "transient", retried: false, ageSeconds: 600 },
        ],
      },
    },
  });

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
  await adminFixtureDatabase().appSetting.upsert({
    where: { key: "reviewOrchestrator.status" },
    create: { key: "reviewOrchestrator.status", value: reviewStatus() },
    update: { value: reviewStatus() },
  });
  await signInAs("owner");
  await page.goto("/admin/qa-release?tab=ci-admission");
  // The analytics consent banner sits over the bottom of the page until declined.
  await page.getByRole("button", { name: "Decline", exact: true }).click();

  const section = page.getByTestId("ci-admission-section");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("ci-admission-slots")).toContainText("52 / 40 runners");
  await expect(section.getByTestId("ci-admission-slots")).toContainText("#800 Release in flight");
  // Deploy CI on develop is shown in the slots it occupies.
  await expect(section.getByTestId("ci-admission-deploy-eeeeeee")).toContainText("Merge pull request #799");
  await expect(section.getByTestId("ci-admission-deploy-eeeeeee")).toContainText("deploy · develop · 18 runners");
  expect(await shownOrder(page)).toEqual([901, 902, 903]);
  // The CI auto-fix: the server's state, and each try under its pull request.
  await expect(section.getByTestId("ci-admission-fix-summary")).toContainText("Claude 64% left");
  await expect(section.getByTestId("ci-admission-fix-summary")).toContainText("2 / 6 fixes this hour");
  await expect(section.getByTestId("ci-admission-fix-state-901")).toHaveText("CI failed · not fixed");
  await expect(section.getByTestId("ci-admission-fix-901")).toContainText("An infrastructure failure with no code cause.");
  await expect(section.getByTestId("ci-admission-fix-state-903")).toHaveText("CI failed · analysing");
  await expect(section.getByTestId("ci-admission-fix-again-903")).toHaveCount(0);
  await expect(section.getByTestId("ci-admission-fix-902")).toHaveCount(0);
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

  // Stop: confirmed, then answered. The fixture has no GitHub App, so the
  // operator is told why nothing was stopped.
  page.once("dialog", (dialog) => void dialog.accept());
  await section.getByTestId("ci-admission-running-800").getByRole("button", { name: "Stop #800: back to draft and cancel its CI" }).click();
  await expect(section.getByRole("status")).toContainText("Stopping needs the CI admission GitHub App.");

  // Analyse again: the fixture has no GitHub App to put the label on.
  await section.getByTestId("ci-admission-fix-again-901").click();
  await expect(section.getByRole("status")).toContainText("Asking again needs the CI admission GitHub App.");

  // The same section in the Light console theme.
  await page.context().addCookies([{ name: "tomverse_admin_theme", value: "light", url: page.url() }]);
  await page.reload();
  await expect(page.getByTestId("ci-admission-section")).toBeVisible();
  await page.screenshot({ path: "test-results-admin/ci-admission-light.png", fullPage: true });
});
