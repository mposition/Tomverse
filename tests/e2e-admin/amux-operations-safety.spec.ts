import { expect, test, adminApi, consoleHeading } from "./support/console";
import { adminFixtureDatabase } from "./support/database";

const HALT_ID = "381491f1-0e11-4122-8000-000000000001";
const REQUEST_ID = "381491f1-0e11-4122-8000-000000000002";
const createMissingAdmissionHalt = () => adminFixtureDatabase().amuxOrchestratorHalt.create({ data: {
  id: HALT_ID, haltKey: REQUEST_ID, requestId: REQUEST_ID,
  reasonCode: "recovery_outcome_unknown", openedAt: new Date(),
} });

test("legacy halt and Decision Maker bookmarks retain their exact operations-settings section", async ({ page, signInAs }) => {
  await signInAs("owner");
  await page.goto("/admin/amux-execution?tab=halts&taskId=task-example");
  await expect(page).toHaveURL("/admin/amux-settings?tab=safety&taskId=task-example");
  await expect(consoleHeading(page)).toHaveText("Operations settings");
  const tabs = page.getByRole("navigation", { name: "AMUX operations settings sections" });
  await expect(tabs.getByRole("link")).toHaveCount(2);
  // The router may retain a hidden previous page; assert the active controls.
  const status = page.getByTestId("amux-halt-status").filter({ visible: true });
  await expect(status).toHaveCount(1);
  await expect(status).toContainText("No halt needs attention");
  await page.goto("/admin/amux-execution?tab=decision-maker");
  await expect(page).toHaveURL("/admin/amux-settings?tab=decision-maker");
  const switches = page.getByTestId("amux-decision-maker-switch-panel").filter({ visible: true });
  await expect(switches).toHaveCount(1);
  await expect(switches).toBeVisible();
});

test("missing admission needs all operator checks, the exact key, and a server-confirmed clear", async ({ page, signInAs }) => {
  await createMissingAdmissionHalt();
  await signInAs("owner");
  await page.goto("/admin/amux-settings?tab=safety");
  const row = page.getByTestId("amux-halt-row").filter({ has: page.getByTestId("amux-halt-clear") });
  await expect(row).toHaveAttribute("data-attention", "operator_required");
  await expect(row).toContainText("not confirmation of no change");
  const decline = page.getByRole("button", { name: "Decline", exact: true });
  if (await decline.isVisible()) await decline.click();
  await page.screenshot({ path: "H:/Project/amux-halt-design-20261012/implemented-desktop-operator-checks.png", fullPage: true });
  const clear = row.getByTestId("amux-halt-clear");
  await row.getByTestId("amux-halt-clear-prefix").fill(REQUEST_ID.slice(0, 8));
  await expect(clear).toBeDisabled();
  const checks = row.getByRole("checkbox");
  await checks.nth(0).check(); await checks.nth(1).check();
  await expect(clear).toBeDisabled();
  await checks.nth(2).check(); await expect(clear).toBeEnabled();
  await clear.click();
  await expect(page.getByTestId("amux-halts-open-count")).toContainText("Open halts: 0");
  const stored = await adminFixtureDatabase().amuxOrchestratorHalt.findUniqueOrThrow({ where: { id: HALT_ID } });
  expect(stored.clearKind).toBe("human"); expect(stored.clearAuditLogId).toBeTruthy();
  await expect(page.getByTestId("amux-halt-row")).toContainText("Operator clear");
  expect(await adminFixtureDatabase().amuxExecutionAttempt.count()).toBe(0);
});

test("ops may inspect recovery evidence but cannot clear a halt through UI or API", async ({ page, signInAs }) => {
  await createMissingAdmissionHalt(); await signInAs("ops");
  await page.goto("/admin/amux-settings?tab=safety");
  await expect(page.getByTestId("amux-halt-row")).toContainText("Only the owner can clear");
  await expect(page.getByTestId("amux-halt-clear")).toHaveCount(0);
  const response = await adminApi(page).post("/api/admin/amux/orchestrator-halts", { haltId: HALT_ID, haltKeyPrefix: REQUEST_ID.slice(0, 8) });
  expect(response.status()).toBe(403);
  expect((await adminFixtureDatabase().amuxOrchestratorHalt.findUniqueOrThrow({ where: { id: HALT_ID } })).clearedAt).toBeNull();
});

test("uncertain clear responses hold the controls and never offer a blind retry", async ({ page, signInAs }) => {
  await createMissingAdmissionHalt(); await signInAs("owner");
  await page.goto("/admin/amux-settings?tab=safety");
  const row = page.getByTestId("amux-halt-row");
  for (const checkbox of await row.getByRole("checkbox").all()) await checkbox.check();
  await row.getByTestId("amux-halt-clear-prefix").fill(REQUEST_ID.slice(0, 8));
  let writes = 0;
  await page.route("**/api/admin/amux/orchestrator-halts", route => { writes += 1; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cleared: true, haltId: "wrong-halt" }) }); });
  await row.getByTestId("amux-halt-clear").click();
  await expect(row).toContainText("clear outcome is unknown");
  await expect(row.getByTestId("amux-halt-clear")).toBeDisabled();
  expect(writes).toBe(1);
  expect((await adminFixtureDatabase().amuxOrchestratorHalt.findUniqueOrThrow({ where: { id: HALT_ID } })).clearedAt).toBeNull();
});

test("recovery checks and cause guidance reflow at 320px, large text and dark theme", async ({ page, context, signInAs }) => {
  await createMissingAdmissionHalt(); await signInAs("owner");
  await context.addCookies([{ name: "tomverse_admin_lang", value: "ko", url: "https://127.0.0.1:3101" }]);
  await page.goto("/admin/amux-settings?tab=safety");
  await expect(page.getByTestId("amux-halt-row")).toContainText("운영 확인 필요");
  await expect(page.getByTestId("amux-halt-row")).toContainText("미반영 확정과는 다릅니다");
  const decline = page.getByRole("button", { name: "Decline", exact: true });
  if (await decline.isVisible()) await decline.click();
  await page.screenshot({ path: "H:/Project/amux-halt-design-20261012/implemented-desktop-ko.png", fullPage: true });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; document.documentElement.classList.add("dark"); });
  const panel = page.getByTestId("amux-orchestrator-halts-panel");
  await expect(panel).toBeVisible();
  const overflow = await page.evaluate(() => ({
    width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth,
    elements: Array.from(document.querySelectorAll("body *")).filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.right > window.innerWidth + 1;
    }).slice(-12).map(element => ({ tag: element.tagName, class: element.className, text: element.textContent?.slice(0, 70) })),
  }));
  expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.width);
  const clear = page.getByTestId("amux-halt-clear");
  await clear.scrollIntoViewIfNeeded();
  const rect = await clear.boundingBox(); expect(rect?.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: "H:/Project/amux-halt-design-20261012/implemented-mobile-large-text.png", fullPage: true });
});
