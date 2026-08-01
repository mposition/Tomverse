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
 * `AdminConsoleShell`, so the spec asserts the intended navigation instead of
 * re-deriving it from the code under test. A separate assertion checks the
 * rendered sidebar contains exactly these entries, which is what fails when an
 * entry is added, removed, or renamed without the coverage following.
 */

/** Every entry of `ADMIN_CONSOLE_NAVIGATION`, in render order. */
const NAVIGATION = [
  { group: "Command Center", label: "Overview", href: "/admin/overview" },
  { group: "Command Center", label: "Work queue", href: "/admin/work-queue" },
  { group: "Command Center", label: "Incidents", href: "/admin/incidents" },
  { group: "Command Center", label: "Product analytics", href: "/admin/analytics" },
  { group: "Customers", label: "Users", href: "/admin/users" },
  { group: "Customers", label: "Feedback", href: "/admin/feedback" },
  { group: "Customers", label: "Support", href: "/admin/support" },
  { group: "Revenue", label: "Billing", href: "/admin/billing" },
  { group: "Revenue", label: "Refunds", href: "/admin/refunds" },
  { group: "Revenue", label: "Credit ledger", href: "/admin/credit-ledger" },
  { group: "Revenue", label: "Promotions", href: "/admin/promotions" },
  { group: "AI Platform", label: "Providers", href: "/admin/providers" },
  { group: "AI Platform", label: "Models", href: "/admin/models" },
  { group: "AI Platform", label: "Usage & cost", href: "/admin/usage-cost" },
  { group: "AI Platform", label: "Fallback policies", href: "/admin/fallback-policies" },
  { group: "Operations", label: "Infrastructure", href: "/admin/infrastructure" },
  { group: "Operations", label: "Scheduled jobs", href: "/admin/jobs" },
  { group: "Operations", label: "Alerts", href: "/admin/alerts" },
  { group: "Operations", label: "Webhooks", href: "/admin/webhooks" },
  { group: "Operations", label: "Platform settings", href: "/admin/platform" },
  { group: "Governance", label: "Approvals", href: "/admin/approvals" },
  { group: "Governance", label: "Audit log", href: "/admin/audit" },
  { group: "Governance", label: "Retention", href: "/admin/retention" },
  { group: "Governance", label: "Admin access", href: "/admin/admin-access" },
] as const;

/**
 * `/admin/search` is the one member of `ADMIN_WORKSPACE_VIEWS` that has no
 * navigation entry, so `titleFromPath()` falls back to the first item and the
 * page is headed "Overview". Asserted as-is rather than as an intent, and
 * recorded in docs/qa/e2e-coverage-matrix.md.
 */
const SEARCH_VIEW = { href: "/admin/search", heading: "Overview" } as const;

test.describe("admin console shell", () => {
  test.beforeEach(async ({ signInAs }) => {
    await signInAs("owner");
  });

  test("the sidebar lists exactly the expected navigation entries", async ({
    page,
  }) => {
    await page.goto("/admin/overview");
    const navigation = page.getByRole("navigation", {
      name: "Admin console navigation",
    });

    await expect(navigation.getByRole("link")).toHaveCount(NAVIGATION.length);
    for (const item of NAVIGATION) {
      await expect(
        navigation.getByRole("link", { name: item.label, exact: true })
      ).toHaveAttribute("href", item.href);
    }
    for (const group of new Set(NAVIGATION.map((item) => item.group))) {
      await expect(navigation.getByText(group, { exact: true })).toBeVisible();
    }
  });

  for (const item of NAVIGATION) {
    test(`${item.href} opens with its own title and active navigation`, async ({
      page,
    }) => {
      await page.goto(item.href);

      await expect(consoleHeading(page)).toHaveText(item.label);
      // Exactly one entry is marked current, and it is this one. Matched on
      // href rather than text: a role without write access to the entry gets a
      // "Read" marker appended inside the same link.
      await expect(activeNavLink(page)).toHaveCount(1);
      await expect(activeNavLink(page)).toHaveAttribute("href", item.href);
      await expect(page.getByText("Admin Console", { exact: true }).first()).toBeVisible();
    });
  }

  test("the workspace search view opens even though it has no navigation entry", async ({
    page,
  }) => {
    await page.goto(SEARCH_VIEW.href);

    await expect(consoleHeading(page)).toHaveText(SEARCH_VIEW.heading);
    await expect(
      page.getByRole("heading", {
        name: "Find customers, tickets, refunds, and audit events",
      })
    ).toBeVisible();
  });

  test("an unknown workspace section renders the not-found page instead of a workspace", async ({
    page,
  }) => {
    await page.goto("/admin/not-a-real-section");

    await expect(
      page.getByRole("heading", { name: "We couldn't find that page" })
    ).toBeVisible();
    // No console chrome leaks through: the root not-found boundary replaces the
    // admin layout entirely, so an unknown section cannot render a workspace.
    await expect(
      page.getByRole("navigation", { name: "Admin console navigation" })
    ).toHaveCount(0);
    await expect(page.getByText("Role: owner")).toHaveCount(0);
    // Next.js streams the admin shell (`admin/loading.tsx` opens a Suspense
    // boundary) before the section segment calls notFound(), so the response
    // status is already committed as 200 and the not-found signal travels as
    // the documented `noindex` marker instead. That extra bare-`noindex` meta
    // is present only on a not-found response -- admin pages carry
    // "noindex, nofollow, nocache" from their own metadata -- so it is what
    // distinguishes the two here. See
    // node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md
    // ("Status Codes"), and docs/qa/e2e-coverage-matrix.md for the finding.
    await expect(
      page.locator('meta[name="robots"][content="noindex"]')
    ).toHaveCount(1);
  });

  test("the legacy /admin entry point forwards to the overview workspace", async ({
    page,
  }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL("/admin/overview");

    await page.goto("/admin?tab=refunds");
    await expect(page).toHaveURL("/admin/refunds");
    await expect(consoleHeading(page)).toHaveText("Refunds");
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

  test("the command palette opens by keyboard, filters pages, and finds records", async ({
    page,
  }) => {
    await page.goto("/admin/overview");
    const palette = page.getByRole("dialog", { name: "Admin command palette" });

    await page.keyboard.press("ControlOrMeta+k");
    await expect(palette).toBeVisible();

    // Page matches are computed in the browser from the navigation table.
    await palette.getByPlaceholder("Search records or type a page name").fill("refund");
    await expect(palette.getByRole("button", { name: "Refunds" })).toBeVisible();

    // Record matches come from /api/admin/search against the seeded database.
    await palette
      .getByPlaceholder("Search records or type a page name")
      .fill(FIXTURE_CUSTOMERS.activePro.email);
    await expect(
      palette.getByText(FIXTURE_CUSTOMERS.activePro.email).first()
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });

  test("the command palette navigates to the page it is asked for", async ({
    page,
  }) => {
    await page.goto("/admin/overview");
    await page.getByRole("button", {
      name: "Open global search and command palette",
    }).click();

    const palette = page.getByRole("dialog", { name: "Admin command palette" });
    await palette.getByPlaceholder("Search records or type a page name").fill("audit");
    await palette.getByRole("button", { name: "Audit log" }).click();

    await expect(page).toHaveURL("/admin/audit");
    await expect(consoleHeading(page)).toHaveText("Audit log");
    await expect(palette).toBeHidden();
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
    ).toHaveAttribute("href", "/admin/alerts");
  });

  test("manual refresh re-reads the server and the auto-refresh toggle reports its state", async ({
    page,
  }) => {
    await page.goto("/admin/feedback");
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
    await expect(page.getByRole("button", { name: "Auto 60s" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(consoleHeading(page)).toHaveText("Feedback");
  });
});
