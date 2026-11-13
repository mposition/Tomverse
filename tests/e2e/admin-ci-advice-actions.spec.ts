import { expect, test } from "@playwright/test";

test("CI suggestions expose every action and copy the same implementation brief", async ({ page, context }, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const posted: { id: string; action: string }[] = [];
  await page.route("**/api/admin/qa-release/ci-advice/*", async (route) => {
    const request = route.request(), id = new URL(request.url()).pathname.split("/").pop()!;
    const { action } = request.postDataJSON();
    posted.push({ id, action });
    await route.fulfill({ json: { item: { id, status: action === "complete" ? "completed" : action === "dismiss" ? "dismissed" : "sent", at: "2026-11-13T09:00:00.000Z", amuxIdeaId: action === "send" ? "idea-fixture" : null } } });
  });
  await page.goto("/e2e/admin-console-fixture?view=ci-advice&locale=ko");
  const first = page.getByTestId("qa-release-ci-advice-item").first();
  await expect(first.getByTestId("qa-release-ci-advice-complete")).toBeVisible();
  await expect(first.getByTestId("qa-release-ci-advice-dismiss")).toBeVisible();
  await expect(first.getByTestId("qa-release-ci-advice-send")).toBeVisible();
  await page.getByTestId("qa-release-ci-advice").screenshot({ path: testInfo.outputPath("ci-advice-actions.png") });
  await first.getByTestId("qa-release-ci-advice-copy").click();
  const brief = await page.evaluate(() => navigator.clipboard.readText());
  expect(brief).toContain("Reuse CI fixtures");
  expect(brief).toContain("preserve security, billing and audit coverage");
  expect(brief).toContain("develop draft PR with ci:hold");
  await first.getByTestId("qa-release-ci-advice-complete").click();
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0]).toEqual({ id: "a".repeat(64), action: "complete" });
  await page.getByTestId("qa-release-ci-advice-item").nth(1).getByTestId("qa-release-ci-advice-send").click();
  await expect.poll(() => posted.length).toBe(2);
  expect(posted[1]).toEqual({ id: "b".repeat(64), action: "send" });
  await page.goto("/e2e/admin-console-fixture?view=ci-advice&locale=ko");
  await page.getByTestId("qa-release-ci-advice-dismiss").first().click();
  await expect.poll(() => posted.length).toBe(3);
  expect(posted[2]).toEqual({ id: "a".repeat(64), action: "dismiss" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});

test("read-only suggestions keep copy available and expired authentication has a return link", async ({ page }) => {
  await page.goto("/e2e/admin-console-fixture?view=ci-advice&readOnly=true");
  const first = page.getByTestId("qa-release-ci-advice-item").first();
  for (const action of ["complete", "dismiss", "send"]) await expect(first.getByTestId(`qa-release-ci-advice-${action}`)).toBeDisabled();
  await expect(first.getByTestId("qa-release-ci-advice-copy")).toBeEnabled();
  await page.route("**/api/admin/qa-release/ci-advice/*", (route) => route.fulfill({ status: 428, json: { error: "ADMIN_REAUTHENTICATION_REQUIRED" } }));
  await page.goto("/e2e/admin-console-fixture?view=ci-advice");
  await page.getByTestId("qa-release-ci-advice-complete").first().click();
  await expect(page.getByTestId("qa-release-ci-advice-failure")).toBeVisible();
  await expect(page.getByTestId("admin-api-reauthenticate-link")).toHaveAttribute("href", /callbackUrl=.*admin.*release/);
});
