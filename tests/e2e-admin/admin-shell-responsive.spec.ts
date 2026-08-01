import {
  consoleHeading,
  expect,
  openMobileNav,
  test,
} from "./support/console";

/**
 * The Admin Console on a narrow viewport.
 *
 * The desktop sidebar is `hidden lg:block`, so below 1024px the only route to
 * the other 23 workspaces is the drawer. These tests are the ones that fail if
 * the drawer stops opening, stops closing, clips its own scroll region, or
 * pushes the page into horizontal overflow.
 *
 * Runs under the `admin-mobile` project (Pixel 5, 412x915); the config's
 * `testMatch` keeps it off the desktop project.
 */

const NAV_LABELS = [
  "Overview",
  "Work queue",
  "Incidents",
  "Product analytics",
  "Users",
  "Feedback",
  "Support",
  "Billing",
  "Refunds",
  "Credit ledger",
  "Promotions",
  "Providers",
  "Models",
  "Usage & cost",
  "Fallback policies",
  "Infrastructure",
  "Scheduled jobs",
  "Alerts",
  "Webhooks",
  "Platform settings",
  "Approvals",
  "Audit log",
  "Retention",
  "Admin access",
];

test.describe("admin console on a narrow viewport", () => {
  test.beforeEach(async ({ signInAs }) => {
    await signInAs("owner");
  });

  test("the navigation drawer is closed until it is asked for", async ({
    page,
  }) => {
    await page.goto("/admin/overview");

    await expect(
      page.getByRole("navigation", { name: "Admin console navigation" })
    ).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Open admin navigation" })
    ).toBeVisible();
  });

  test("every workspace stays reachable from the drawer", async ({ page }) => {
    await page.goto("/admin/overview");
    await openMobileNav(page);

    const navigation = page
      .getByRole("navigation", { name: "Admin console navigation" })
      .filter({ visible: true });
    for (const label of NAV_LABELS) {
      const link = navigation.getByRole("link", { name: label, exact: true });
      await link.scrollIntoViewIfNeeded();
      // Reachability measured from the control's own centre point, not from
      // attachment: an entry covered by the header or clipped out of the
      // scroll region is not reachable even though it is in the DOM.
      const box = await link.boundingBox();
      expect(box, `${label} has no layout box`).not.toBeNull();
      const topmost = await page.evaluate(
        ([x, y]) => {
          const element = document.elementFromPoint(x as number, y as number);
          return element?.closest("a")?.textContent?.trim() ?? null;
        },
        [box!.x + box!.width / 2, box!.y + box!.height / 2]
      );
      expect(topmost, `${label} is covered by another element`).toContain(label);
    }
  });

  test("choosing a workspace navigates and closes the drawer", async ({
    page,
  }) => {
    await page.goto("/admin/overview");
    await openMobileNav(page);

    await page
      .getByRole("navigation", { name: "Admin console navigation" })
      .filter({ visible: true })
      .getByRole("link", { name: "Refunds", exact: true })
      .click();

    await expect(page).toHaveURL("/admin/refunds");
    await expect(consoleHeading(page)).toHaveText("Refunds");
    await expect(
      page.getByRole("button", { name: "Close navigation" })
    ).toBeHidden();
  });

  test("the drawer closes with Escape and with its backdrop", async ({
    page,
  }) => {
    await page.goto("/admin/overview");

    await openMobileNav(page);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Close navigation" })
    ).toBeHidden();

    await openMobileNav(page);
    // The backdrop spans the viewport but the drawer sits on top of its left
    // 320px, so the click has to land to the right of the panel.
    await page
      .getByRole("button", { name: "Close navigation" })
      .click({ position: { x: 390, y: 500 } });
    await expect(
      page.getByRole("button", { name: "Close navigation" })
    ).toBeHidden();
    await expect(consoleHeading(page)).toHaveText("Overview");
  });

  test("the header controls stay usable and nothing overflows sideways", async ({
    page,
  }) => {
    for (const width of [412, 320]) {
      await page.setViewportSize({ width, height: 915 });
      await page.goto("/admin/users");

      await expect(consoleHeading(page)).toHaveText("Users");
      await expect(
        page.getByRole("button", { name: "Open admin navigation" })
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: "Open global search and command palette",
        })
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Open notification center" })
      ).toBeVisible();

      const overflow = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth,
      }));
      expect(
        overflow.content,
        `horizontal overflow at ${width}px`
      ).toBeLessThanOrEqual(overflow.viewport + 1);
    }
  });

  test("the command palette is usable without a hardware keyboard", async ({
    page,
  }) => {
    await page.goto("/admin/overview");
    await page
      .getByRole("button", { name: "Open global search and command palette" })
      .click();

    const palette = page.getByRole("dialog", { name: "Admin command palette" });
    await expect(palette).toBeVisible();
    await palette.getByRole("button", { name: "Close", exact: true }).click();
    await expect(palette).toBeHidden();
  });
});
