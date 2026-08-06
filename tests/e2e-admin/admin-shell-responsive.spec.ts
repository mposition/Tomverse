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
 * the other sixteen workspaces is the drawer. These tests are the ones that fail
 * if the drawer stops opening, stops closing, clips its own scroll region,
 * hides a group's contents behind a collapsed toggle, or pushes the page into
 * horizontal overflow.
 *
 * Runs under the `admin-mobile` project (Pixel 5, 412x915); the config's
 * `testMatch` keeps it off the desktop project. Individual tests set 390px and
 * 320px explicitly.
 */

const NAV_LABELS = [
  "Overview",
  "Work queue",
  "Analytics",
  "Users",
  "Support",
  "Billing",
  "Refunds",
  "Credit ledger",
  "Providers",
  "Models",
  "Infrastructure",
  "Automation",
  "Alerts",
  "Platform settings",
  "Audit log",
  "Retention",
  "Admin access",
];

const NAV_GROUPS = [
  "Command Center",
  "Customers",
  "Revenue",
  "AI Platform",
  "Operations",
  "Governance",
];

const drawerNav = (page: import("@playwright/test").Page) =>
  page
    .getByRole("navigation", { name: "Admin console navigation" })
    .filter({ visible: true });

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

  for (const width of [390, 320]) {
    test(`every workspace stays reachable from the drawer at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/admin/overview");
      await openMobileNav(page);

      const navigation = drawerNav(page);
      for (const label of NAV_LABELS) {
        const link = navigation.getByRole("link", { name: label });
        await link.scrollIntoViewIfNeeded();
        // Reachability measured from the control's own centre point, not from
        // attachment: an entry covered by the header or clipped out of the
        // scroll region is not reachable even though it is in the DOM.
        //
        // Measured and hit-tested in one evaluation. Splitting them lets a
        // scroll that lands between the two calls invalidate the coordinates,
        // which produces a failure about the wrong element rather than about
        // reachability.
        const topmost = await link.evaluate((element) => {
          const box = element.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) return null;
          return (
            document
              .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
              ?.closest("a")
              ?.textContent?.trim() ?? null
          );
        });
        expect(topmost, `${label} is covered by another element`).toContain(label);
      }
    });
  }

  test("the drawer explains each entry in visible text, not only a title", async ({
    page,
  }) => {
    await page.goto("/admin/overview");
    await openMobileNav(page);
    const navigation = drawerNav(page);

    // A `title` attribute is a hover affordance and cannot be reached on a
    // touch device, so the drawer renders the same sentence as text.
    const workQueue = navigation.getByRole("link", { name: /^Work queue/ });
    await expect(workQueue).not.toHaveAttribute("title", /./);
    await expect(
      workQueue.getByText("Everything waiting on an operator, oldest first")
    ).toBeVisible();
  });

  test("the drawer opens on the current entry without scrolling first", async ({
    page,
  }) => {
    // The last entry of the last group, well below the fold on a phone.
    await page.goto("/admin/admin-access");
    await openMobileNav(page);

    const current = drawerNav(page).locator('a[aria-current="page"]');
    await expect(current).toHaveAttribute("href", "/admin/admin-access");
    // Polled: the reveal runs on the frame after the drawer is painted, so the
    // first measurement can precede it. What is asserted is that it happens
    // without the operator scrolling, not that it happens synchronously.
    await expect
      .poll(async () =>
        current.evaluate((element) => {
          const box = element.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) return null;
          return (
            document
              .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
              ?.closest("a")
              ?.getAttribute("href") ?? null
          );
        })
      )
      .toBe("/admin/admin-access");
  });

  test("groups collapse in the drawer and report their state", async ({
    page,
  }) => {
    await page.goto("/admin/overview");
    await openMobileNav(page);
    const navigation = drawerNav(page);

    for (const group of NAV_GROUPS) {
      await expect(
        navigation.getByRole("button", { name: group })
      ).toHaveAttribute("aria-expanded", "true");
    }

    const operations = navigation.getByRole("button", { name: "Operations" });
    await operations.click();
    await expect(operations).toHaveAttribute("aria-expanded", "false");
    await expect(navigation.getByRole("link", { name: "Alerts" })).toBeHidden();
    await operations.click();
    await expect(navigation.getByRole("link", { name: /^Alerts/ })).toBeVisible();
  });

  test("choosing a workspace navigates and closes the drawer", async ({
    page,
  }) => {
    await page.goto("/admin/overview");
    await openMobileNav(page);

    await drawerNav(page).getByRole("link", { name: /^Refunds/ }).click();

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
    for (const width of [412, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
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

  test("a consolidated page's tab strip is reachable and does not overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto("/admin/providers");

    const tabs = page.getByRole("navigation", { name: "Provider sections" });
    await expect(tabs.getByRole("link", { name: "Health" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    await tabs.getByRole("link", { name: "Incidents & fallback" }).click();
    await expect(page).toHaveURL("/admin/providers?tab=incidents");

    const overflow = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(overflow.content).toBeLessThanOrEqual(overflow.viewport + 1);
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
