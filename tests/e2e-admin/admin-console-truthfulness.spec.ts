import { consoleHeading, expect, test } from "./support/console";

/**
 * The console is not allowed to state things it does not know.
 *
 * Three surfaces used to, and each was found the same way -- by an operator
 * acting on what the screen said and finding the screen was wrong.
 *
 * 1. The alerts drawer wrote rows only on a 2xx and rendered "No notification
 *    records." otherwise, so a 500 read as an empty inbox on the surface
 *    opened first during an incident.
 * 2. The environment panel said "not configured" for a variable that is set on
 *    the deployment host but was added after this process started, sending a
 *    diagnosis toward generating a key that already existed.
 * 3. The health score was one integer with no way to see the six weighted
 *    counts inside it, and it charged ten points for variables the table
 *    itself calls optional.
 *
 * The unit tests pin the decisions; this pins that they reach the screen.
 */

test.describe("the console says only what it knows", () => {
  test.beforeEach(async ({ signInAs }) => {
    await signInAs("owner");
  });

  test("a notification read that failed is reported as unread, not as empty", async ({
    page,
  }) => {
    await page.route("**/api/admin/notifications**", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Failed to load notifications." }),
      })
    );

    await page.goto("/admin/overview");
    await page.getByRole("button", { name: "Open notification center" }).click();

    const failure = page.getByTestId("admin-alerts-error");
    await expect(failure).toBeVisible();
    await expect(failure).toContainText("500");
    // The defect in one assertion: the drawer must not claim an empty inbox
    // out of a read it never completed.
    await expect(page.getByText("No notification records.")).toHaveCount(0);

    // And the failure is recoverable in place. The old guard returned on every
    // reopen because the row list was still empty, so the drawer stayed stuck
    // on its first error until a full page load.
    await page.unroute("**/api/admin/notifications**");
    await page.route("**/api/admin/notifications**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ logs: [] }),
      })
    );
    await page.getByTestId("admin-alerts-retry").click();
    await expect(page.getByTestId("admin-alerts-error")).toHaveCount(0);
    // Now the empty state is a real answer rather than the absence of one.
    await expect(page.getByText("No notification records.")).toBeVisible();
  });

  test("the health score opens onto the arithmetic that produced it", async ({
    page,
  }) => {
    await page.goto("/admin/overview");
    await expect(consoleHeading(page)).toHaveText("Overview");

    await page.getByTestId("admin-health-score-link").click();
    await expect(page).toHaveURL("/admin/overview?tab=health");

    // Every factor is on screen whether or not it is currently deducting: a
    // panel that hid the zero lines could not be used to check that a fixed
    // thing is actually reading as fixed.
    for (const factor of [
      "outage",
      "blockingEnv",
      "limited",
      "alertFailure",
      "pendingRefund",
      "openFeedback",
    ]) {
      await expect(page.getByTestId(`admin-health-line-${factor}`)).toBeVisible();
    }

    // The grouping is the point: an unset optional channel is listed and
    // priced at nothing, in its own section, rather than counted with the
    // things that are actually broken.
    // Matched by prefix: each group heading carries its own count, so the
    // accessible name is "Required — deducting now (3)".
    await expect(
      page.getByRole("heading", { name: /^Required — deducting now/ })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /^Optional — not deducting/ })
    ).toBeVisible();

    // And the page states the limit of its own knowledge.
    await expect(page.getByTestId("admin-health-process-window")).toContainText(
      "started at"
    );
  });

  test("the environment panel says which process it read", async ({ page }) => {
    await page.goto("/admin/overview");

    // "Not configured" and "configured after this process started" are
    // different facts and used to render identically. The panel now dates the
    // environment it is reporting on.
    await expect(
      page.getByTestId("admin-overview-process-window")
    ).toContainText("redeployed");
  });

  test("switching Overview sections keeps the workspace and the sidebar entry", async ({
    page,
  }) => {
    await page.goto("/admin/overview?tab=health");

    const tabStrip = page.getByRole("navigation", { name: /sections$/ });
    await expect(tabStrip.locator('a[aria-current="page"]')).toHaveAttribute(
      "href",
      /tab=health$/
    );
    await expect(consoleHeading(page)).toHaveText("Overview");

    await tabStrip.getByRole("link", { name: "Summary" }).click();
    await expect(page).toHaveURL("/admin/overview?tab=summary");
    await expect(
      page.getByRole("heading", { name: "Operations snapshot" })
    ).toBeVisible();
  });
});
