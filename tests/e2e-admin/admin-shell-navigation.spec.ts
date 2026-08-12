import {
  FIXTURE_CUSTOMERS,
  FIXTURE_NOTIFICATION,
  activeNavLink,
  adminApi,
  consoleHeading,
  expect,
  test,
} from "./support/console";

/**
 * The Admin Console shell: routing, navigation state, and the header controls.
 *
 * The route table is written out here rather than imported from
 * `lib/adminNavigation.ts`, so the spec asserts the intended navigation instead
 * of re-deriving it from the code under test. A separate assertion checks the
 * rendered sidebar contains exactly these entries, which is what fails when an
 * entry is added, removed, or renamed without the coverage following.
 */

/** Every entry of `ADMIN_NAVIGATION`, in render order. */
const NAVIGATION = [
  { group: "Command Center", label: "Overview", href: "/admin/overview" },
  { group: "Command Center", label: "Work queue", href: "/admin/work-queue" },
  { group: "Command Center", label: "Analytics", href: "/admin/analytics" },
  { group: "Customers", label: "Users", href: "/admin/users" },
  { group: "Customers", label: "Support", href: "/admin/support" },
  { group: "Revenue", label: "Billing", href: "/admin/billing" },
  { group: "Revenue", label: "Refunds", href: "/admin/refunds" },
  { group: "Revenue", label: "Credit ledger", href: "/admin/credit-ledger" },
  { group: "AI Platform", label: "Providers", href: "/admin/providers" },
  { group: "AI Platform", label: "Models", href: "/admin/models" },
  { group: "AI Platform", label: "Routing", href: "/admin/routing" },
  { group: "Operations", label: "Infrastructure", href: "/admin/infrastructure" },
  { group: "Operations", label: "Automation", href: "/admin/automation" },
  { group: "Operations", label: "Alerts", href: "/admin/alerts" },
  { group: "Operations", label: "Platform settings", href: "/admin/platform" },
  { group: "Governance", label: "Audit log", href: "/admin/audit" },
  { group: "Governance", label: "Retention", href: "/admin/retention" },
  { group: "Governance", label: "Admin access", href: "/admin/admin-access" },
] as const;

/**
 * Every route the console used to have, and where it now lands.
 *
 * A bookmark, a runbook link or an `href` already written into an audit summary
 * has to keep working, and it has to land on the *section* it named -- not on
 * the first tab of whichever page absorbed it.
 */
const LEGACY_ROUTES = [
  { from: "/admin/feedback", to: "/admin/support?tab=feedback", heading: "Support" },
  {
    from: "/admin/promotions",
    to: "/admin/billing?tab=promotions",
    heading: "Billing",
  },
  {
    from: "/admin/incidents",
    to: "/admin/providers?tab=incidents",
    heading: "Providers",
  },
  {
    from: "/admin/fallback-policies",
    to: "/admin/providers?tab=incidents",
    heading: "Providers",
  },
  {
    from: "/admin/usage-cost",
    to: "/admin/providers?tab=usage-cost",
    heading: "Providers",
  },
  { from: "/admin/jobs", to: "/admin/automation?tab=jobs", heading: "Automation" },
  {
    from: "/admin/webhooks",
    to: "/admin/automation?tab=webhooks",
    heading: "Automation",
  },
  {
    from: "/admin/approvals",
    to: "/admin/work-queue?tab=approvals",
    heading: "Work queue",
  },
] as const;

/** `/admin/search` is a real page with no sidebar entry, and says so. */
const SEARCH_VIEW = { href: "/admin/search", heading: "Global search" } as const;

const sidebarNav = (page: import("@playwright/test").Page) =>
  page.getByRole("navigation", { name: "Admin console navigation" });

test.describe("admin console shell", () => {
  test.beforeEach(async ({ signInAs }) => {
    await signInAs("owner");
  });

  test("the sidebar lists exactly the expected navigation entries", async ({
    page,
  }) => {
    await page.goto("/admin/overview");
    const navigation = sidebarNav(page);

    await expect(navigation.getByRole("link")).toHaveCount(NAVIGATION.length);
    for (const item of NAVIGATION) {
      await expect(
        navigation.getByRole("link", { name: item.label })
      ).toHaveAttribute("href", item.href);
    }
    for (const group of new Set(NAVIGATION.map((item) => item.group))) {
      await expect(
        navigation.getByRole("button", { name: group })
      ).toBeVisible();
    }
  });

  for (const item of NAVIGATION) {
    test(`${item.href} opens with its own title and active navigation`, async ({
      page,
    }) => {
      await page.goto(item.href);

      await expect(consoleHeading(page)).toHaveText(item.label);
      // Exactly one entry is marked current, and it is this one. Matched on
      // href rather than text: the entry's accessible name also states its
      // pending count and whether the role may write there.
      await expect(activeNavLink(page)).toHaveCount(1);
      await expect(activeNavLink(page)).toHaveAttribute("href", item.href);
      await expect(page.getByText("Admin Console", { exact: true }).first()).toBeVisible();
    });
  }

  test("the global search workspace is titled Global search, not Overview", async ({
    page,
  }) => {
    await page.goto(SEARCH_VIEW.href);

    // The old shell fell through to the first navigation entry for any route
    // without a sidebar item, so this page was headed "Overview".
    await expect(consoleHeading(page)).toHaveText(SEARCH_VIEW.heading);
    await expect(
      page.getByRole("heading", {
        name: "Find customers, tickets, refunds, and audit events",
      })
    ).toBeVisible();
    // No sidebar entry claims to be current on a page that has none.
    await expect(activeNavLink(page)).toHaveCount(0);
  });

  for (const legacy of LEGACY_ROUTES) {
    test(`${legacy.from} still resolves, at ${legacy.to}`, async ({ page }) => {
      await page.goto(legacy.from);

      await expect(page).toHaveURL(legacy.to);
      await expect(consoleHeading(page)).toHaveText(legacy.heading);
      // The tab named in the destination is the one that opened.
      const tab = new URL(legacy.to, "https://example.invalid").searchParams.get(
        "tab"
      );
      const tabStrip = page.getByRole("navigation", { name: /sections$/ });
      await expect(tabStrip.locator('a[aria-current="page"]')).toHaveAttribute(
        "href",
        new RegExp(`tab=${tab}$`)
      );
    });
  }

  test("a legacy route carries its own query onto the new destination", async ({
    page,
  }) => {
    await page.goto("/admin/feedback?status=resolved");

    await expect(page).toHaveURL("/admin/support?tab=feedback&status=resolved");
    // The filter the bookmark asked for is the one the inbox opened on.
    await expect(page.getByText("Streaming stalls when I switch models mid-answer.")).toHaveCount(
      0
    );
  });

  test("an unknown workspace section renders the not-found page instead of a workspace", async ({
    page,
  }) => {
    await page.goto("/admin/overview");
    await expect(consoleHeading(page)).toHaveText("Overview");

    const response = await page.goto("/admin/not-a-real-section");

    // With every workspace on its own route segment there is no catch-all left
    // to match, so the router answers 404 before anything streams. The console
    // previously served 200 here, because `admin/loading.tsx` had already
    // committed the status by the time the `[section]` segment called
    // notFound(). See docs/qa/e2e-coverage-matrix.md, finding 1.
    expect(response?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: "We couldn't find that page" })
    ).toBeVisible();
    // No console chrome leaks through: the root not-found boundary replaces the
    // admin layout entirely.
    await expect(sidebarNav(page)).toHaveCount(0);
    await expect(page.getByText("Role: owner")).toHaveCount(0);
  });

  test("the legacy /admin entry point forwards to the overview workspace", async ({
    page,
  }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL("/admin/overview");

    await page.goto("/admin?tab=refunds");
    await expect(page).toHaveURL("/admin/refunds");
    await expect(consoleHeading(page)).toHaveText("Refunds");

    // A `?tab=` value that named a now-merged workspace forwards to the tab
    // that absorbed it.
    await page.goto("/admin?tab=feedback");
    await expect(page).toHaveURL("/admin/support?tab=feedback");
  });

  test("the breadcrumb reflects the nested customer detail route", async ({
    page,
  }) => {
    await page.goto(`/admin/users/${FIXTURE_CUSTOMERS.activePro.id}`);

    await expect(consoleHeading(page)).toHaveText("Customer detail");
    const breadcrumb = page.locator("main").first();
    await expect(
      breadcrumb.getByRole("link", { name: "Admin Console" })
    ).toBeVisible();
    await expect(
      breadcrumb.getByRole("link", { name: "Users", exact: true })
    ).toHaveAttribute("href", "/admin/users");
    // The parent navigation entry stays current for the child route.
    await expect(activeNavLink(page)).toHaveAttribute("href", "/admin/users");
  });

  test("the header reports the signed-in administrator and their role", async ({
    page,
  }) => {
    await page.goto("/admin/overview");

    await expect(page.getByText("E2E Owner")).toBeVisible();
    await expect(page.getByText("owner", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Role: owner")).toBeVisible();
    // owner may write everywhere, so the read-only chip must not appear.
    await expect(page.getByText(/^Read-only for/)).toHaveCount(0);
  });

  test("sidebar groups collapse and expand, by pointer and by keyboard", async ({
    page,
  }) => {
    await page.goto("/admin/overview");
    const navigation = sidebarNav(page);
    const revenue = navigation.getByRole("button", { name: "Revenue" });

    await expect(revenue).toHaveAttribute("aria-expanded", "true");
    await expect(navigation.getByRole("link", { name: "Refunds" })).toBeVisible();

    await revenue.click();
    await expect(revenue).toHaveAttribute("aria-expanded", "false");
    await expect(navigation.getByRole("link", { name: "Refunds" })).toBeHidden();

    // The toggle is a real button, so Enter and Space operate it without any
    // key handling of the console's own.
    await revenue.focus();
    await page.keyboard.press("Enter");
    await expect(revenue).toHaveAttribute("aria-expanded", "true");
    await expect(navigation.getByRole("link", { name: "Refunds" })).toBeVisible();
  });

  test("the group holding the current route is open even when it was collapsed", async ({
    page,
  }) => {
    await page.goto("/admin/overview");
    const navigation = sidebarNav(page);
    await navigation.getByRole("button", { name: "Governance" }).click();
    await expect(
      navigation.getByRole("button", { name: "Governance" })
    ).toHaveAttribute("aria-expanded", "false");

    // Arriving at a route inside the collapsed group reveals it, rather than
    // leaving the operator on a page whose entry is hidden.
    await page.goto("/admin/retention");
    await expect(
      navigation.getByRole("button", { name: "Governance" })
    ).toHaveAttribute("aria-expanded", "true");
    await expect(activeNavLink(page)).toHaveAttribute("href", "/admin/retention");
  });

  test("the current entry is in view on a 1280x720 desktop, without scrolling first", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    // The last entry of the last group: below the fold at this height unless
    // the sidebar brings it into view on arrival.
    await page.goto("/admin/admin-access");

    const current = activeNavLink(page);
    await expect(current).toHaveAttribute("href", "/admin/admin-access");
    const box = await current.boundingBox();
    expect(box, "the current entry has no layout box").not.toBeNull();
    const topmost = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x as number, y as number)?.closest("a")?.getAttribute("href") ?? null,
      [box!.x + box!.width / 2, box!.y + box!.height / 2]
    );
    expect(topmost).toBe("/admin/admin-access");
  });

  test("entries that need action carry a count, and the rest do not", async ({
    page,
  }) => {
    await page.goto("/admin/overview");
    const navigation = sidebarNav(page);

    // One pending refund is seeded, so Refunds states it in its own name.
    await expect(
      navigation.getByRole("link", { name: /^Refunds, \d+ awaiting action/ })
    ).toBeVisible();
    // Reference pages carry no counter at all.
    await expect(
      navigation.getByRole("link", { name: "Audit log", exact: true })
    ).toBeVisible();
  });

  test("any page can be pinned, and the pin shows up in the sidebar and the palette", async ({
    page,
  }) => {
    await page.goto("/admin/retention");
    const quickAccess = page.getByRole("navigation", { name: "Quick access" });

    await expect(
      quickAccess.getByRole("link", { name: "Retention" })
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Pin page" }).click();
    await expect(
      quickAccess.getByRole("link", { name: "Retention" })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Pinned" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    // The palette reads the same list.
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Admin command palette" });
    const pinnedSection = palette
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Pinned" }) });
    await expect(
      pinnedSection.getByRole("option", { name: /Retention/ })
    ).toBeVisible();
    await page.keyboard.press("Escape");

    // Unpinning is the same control, and it sticks.
    await page.getByRole("button", { name: "Pinned" }).click();
    await expect(
      quickAccess.getByRole("link", { name: "Retention" })
    ).toHaveCount(0);
  });

  test("the empty command palette can reach every page, grouped", async ({
    page,
  }) => {
    await page.goto("/admin/overview");
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Admin command palette" });
    await expect(palette).toBeVisible();

    // Every navigation entry is listed under its own group heading -- the
    // palette used to show `ALL_ITEMS.slice(0, 9)` and silently omit the rest.
    for (const item of NAVIGATION) {
      const section = palette
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: item.group, exact: true }) });
      await expect(
        section.getByRole("option", { name: new RegExp(`^${item.label}`) })
      ).toHaveCount(1);
    }
    // Including the page that has no sidebar entry.
    await expect(
      palette.getByRole("option", { name: /^Global search/ })
    ).toBeVisible();
  });

  test("the command palette separates page results from record results", async ({
    page,
  }) => {
    await page.goto("/admin/overview");
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Admin command palette" });

    await palette.getByPlaceholder("Search records or type a page name").fill("refund");
    await expect(palette.getByRole("heading", { name: /^Pages \(/ })).toBeVisible();
    await expect(palette.getByRole("option", { name: /^Refunds/ })).toBeVisible();
    await expect(palette.getByRole("heading", { name: /^Records \(/ })).toBeVisible();

    // A query that matches a page and no record is not a failed search, and
    // the palette no longer says it is: the "nothing matched" line belongs to
    // the Records section and states that the page results still stand.
    await palette
      .getByPlaceholder("Search records or type a page name")
      .fill("retention");
    await expect(palette.getByRole("option", { name: /^Retention/ })).toBeVisible();
    await expect(palette.getByText("No matching records.")).toHaveCount(0);
    await expect(
      palette.getByText(/Page results above are unaffected/)
    ).toBeVisible();

    // Record matches come from /api/admin/search against the seeded database.
    await palette
      .getByPlaceholder("Search records or type a page name")
      .fill(FIXTURE_CUSTOMERS.activePro.email);
    await expect(
      palette.getByText(FIXTURE_CUSTOMERS.activePro.email).first()
    ).toBeVisible();
    await expect(
      palette.getByRole("option", { name: /^View all results/ })
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });

  test("the command palette is driveable with the arrow keys and Enter", async ({
    page,
  }) => {
    await page.goto("/admin/overview");
    await page.getByRole("button", {
      name: "Open global search and command palette",
    }).click();

    const palette = page.getByRole("dialog", { name: "Admin command palette" });
    await palette.getByPlaceholder("Search records or type a page name").fill("audit");

    // The first option is selected without any key press, and Enter opens it.
    await expect(palette.getByRole("option", { selected: true })).toHaveCount(1);
    await expect(
      palette.getByRole("option", { selected: true })
    ).toHaveText(/Audit log/);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await expect(
      palette.getByRole("option", { selected: true })
    ).toHaveText(/Audit log/);
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL("/admin/audit");
    await expect(consoleHeading(page)).toHaveText("Audit log");
    await expect(palette).toBeHidden();
  });

  test("the palette hands a query to the global search workspace", async ({
    page,
  }) => {
    await page.goto("/admin/overview");
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Admin command palette" });
    await palette
      .getByPlaceholder("Search records or type a page name")
      .fill(FIXTURE_CUSTOMERS.disputedHold.email);
    await palette.getByRole("option", { name: /^View all results/ }).click();

    await expect(page).toHaveURL(
      `/admin/search?q=${encodeURIComponent(FIXTURE_CUSTOMERS.disputedHold.email)}`
    );
    await expect(consoleHeading(page)).toHaveText("Global search");
  });

  test("the notification center loads delivery records on demand", async ({
    page,
  }) => {
    await page.goto("/admin/overview");
    const bell = page.getByRole("button", { name: "Open notification center" });

    await expect(bell).toHaveAttribute("aria-expanded", "false");
    await bell.click();
    await expect(bell).toHaveAttribute("aria-expanded", "true");

    await expect(page.getByText("Notification center")).toBeVisible();
    await expect(
      page.getByText(FIXTURE_NOTIFICATION.failed.title)
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "View all" })
    ).toHaveAttribute("href", "/admin/alerts?tab=deliveries");
  });

  test("manual refresh re-reads the server and the auto-refresh toggle names its own period", async ({
    page,
  }) => {
    await page.goto("/admin/support?tab=feedback");
    await expect(
      page.getByText("Streaming stalls when I switch models mid-answer.")
    ).toBeVisible();

    // Change the data behind the console's back, then use the console's own
    // refresh control: a working refresh is the only way the new row appears.
    const api = adminApi(page);
    const created = await api.post("/api/admin/notes", {
      targetType: "User",
      targetId: FIXTURE_CUSTOMERS.activePro.id,
      body: "Refresh control regression note.",
    });
    expect(created.ok()).toBe(true);

    const autoRefresh = page.getByRole("button", { name: "Manual refresh" });
    await expect(autoRefresh).toHaveAttribute("aria-pressed", "false");
    await autoRefresh.click();
    // The interval is 180000ms. The button used to read "Auto 60s" beside it,
    // so the console claimed a freshness it did not have; label and timer are
    // now derived from one constant.
    await expect(page.getByRole("button", { name: "Auto 3m" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(consoleHeading(page)).toHaveText("Support");
  });
});
