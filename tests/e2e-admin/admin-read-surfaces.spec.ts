import {
  ADMIN_E2E_IDENTITIES,
  FIXTURE_ALERT_POLICY,
  FIXTURE_ANALYTICS,
  FIXTURE_AUDIT_LOG,
  FIXTURE_CONVERSATION,
  FIXTURE_CREDIT,
  FIXTURE_CUSTOMERS,
  FIXTURE_FEEDBACK,
  FIXTURE_INCIDENT,
  FIXTURE_JOB_RUN,
  FIXTURE_MODEL,
  FIXTURE_NOTIFICATION,
  FIXTURE_PRIVACY_REQUEST,
  FIXTURE_PROMOTION,
  FIXTURE_REFUNDS,
  FIXTURE_WEBHOOK,
  consoleHeading,
  expect,
  test,
} from "./support/console";

/**
 * Contract coverage for every Admin Console read surface, including every tab
 * of the consolidated pages.
 *
 * Each test asserts that seeded rows actually reach the screen -- a heading
 * plus a representative record, an empty state, or a status badge. A 200 alone
 * would pass with an empty panel, a swallowed fetch error, or a serialization
 * bug, all of which are the failures these surfaces are most prone to.
 *
 * Several panels are client components that fetch after mount, so this file
 * exists specifically to exercise them in a browser rather than through
 * server-rendered HTML.
 */

test.describe("admin read surfaces", () => {
  test.beforeEach(async ({ signInAs }) => {
    await signInAs("owner");
  });

  test("overview summarises accounts, attention items, and recent admin activity", async ({
    page,
  }) => {
    await page.goto("/admin/overview");

    await expect(consoleHeading(page)).toHaveText("Overview");
    await expect(
      page.getByRole("heading", { name: "Operations snapshot" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Launch readiness queue" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Revenue and retention snapshot" })
    ).toBeVisible();
    // The work-queue counter is computed from the seeded open feedback and
    // pending refund. (The "Needs attention" list is capped at six items and
    // is dominated by unconfigured providers on this fixture, so the counter
    // is the deterministic signal.)
    await expect(page.getByText("2 feedback / 1 refund")).toBeVisible();
    // Recent administrator activity replays the seeded audit row.
    await expect(page.getByText(FIXTURE_AUDIT_LOG.summary)).toBeVisible();
    // Each fact appears once: the operations snapshot, the KPI strip, the
    // attention list and the environment table used to be rendered twice each.
    await expect(
      page.getByRole("heading", { name: "Launch readiness queue" })
    ).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: "Environment health" })
    ).toHaveCount(1);
  });

  test("overview offers pinned pages instead of a default-view control", async ({
    page,
  }) => {
    await page.goto("/admin/overview");

    await expect(
      page.getByRole("heading", { name: "Quick access" })
    ).toBeVisible();
    // "Set default" wrote a preference nothing read; it is gone rather than
    // renamed.
    await expect(page.getByRole("button", { name: "Set default" })).toHaveCount(0);
  });

  test("the work queue ranks every open item and links to the page that owns it", async ({
    page,
  }) => {
    await page.goto("/admin/work-queue");

    await expect(
      page.getByRole("heading", { name: "Open work, oldest first" })
    ).toBeVisible();
    // The refund, the privacy request and the open feedback all appear as queue
    // rows, each linking to the workspace that can act on it. Matched on the
    // row's own title rather than on the email, which the seeded refund and the
    // seeded privacy request share.
    await expect(
      page.getByRole("link", {
        name: new RegExp(`Refund request from ${FIXTURE_REFUNDS.pending.email}`),
      })
    ).toHaveAttribute("href", "/admin/refunds");
    await expect(
      page.getByRole("link", { name: /export request from/ }).first()
    ).toHaveAttribute("href", "/admin/support?tab=privacy");
    await expect(
      page.getByRole("link", { name: new RegExp(FIXTURE_FEEDBACK.open.message.slice(0, 30)) }).first()
    ).toHaveAttribute("href", "/admin/support?tab=feedback");
    // Only open items belong in the queue.
    await expect(page.getByText(FIXTURE_FEEDBACK.resolved.message)).toHaveCount(0);
    // The queue no longer stacks whole management panels underneath itself.
    await expect(
      page.getByRole("heading", { name: "Scheduled jobs" })
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Cancellation and refund requests" })
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Open support age" })
    ).toBeVisible();
  });

  test("the work queue's approvals tab shows the approval queue", async ({
    page,
  }) => {
    await page.goto("/admin/work-queue?tab=approvals");

    await expect(
      page.getByRole("heading", { name: "High-risk admin approvals" })
    ).toBeVisible();
    await expect(page.getByText(/No .*approval/i).first()).toBeVisible();
  });

  test("providers' incidents tab lists open and resolved incidents", async ({
    page,
  }) => {
    await page.goto("/admin/providers?tab=incidents");

    await expect(page.getByText(FIXTURE_INCIDENT.active.title)).toBeVisible();
    await expect(page.getByText(FIXTURE_INCIDENT.resolved.title)).toBeVisible();
    // The open one can still be resolved; the resolved one offers no action.
    await expect(page.getByRole("button", { name: "Resolve" })).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: "Provider readiness tests" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Incident mode" })
    ).toBeVisible();
  });

  test("analytics renders the product funnel from seeded events", async ({
    page,
  }) => {
    await page.goto("/admin/analytics");

    await expect(consoleHeading(page)).toHaveText("Analytics");
    await expect(
      page.getByRole("heading", { name: "Event funnel · last 30 days" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Go-live funnel and activation" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Top acquisition campaigns · 30d" })
    ).toBeVisible();
    // The account-level funnel moved here from the promotions workspace.
    await expect(
      page.getByRole("heading", { name: "Launch conversion funnel" })
    ).toBeVisible();
    // The seeded landing_view events reach both the funnel and the campaigns
    // table, which is what distinguishes a rendered dashboard from an empty one.
    await expect(
      page.getByText(FIXTURE_ANALYTICS.utmCampaign).first()
    ).toBeVisible();
    await expect(page.getByText(FIXTURE_ANALYTICS.eventName)).toBeVisible();
  });

  test("analytics' imports tab renders the content-free import and memory report", async ({
    page,
  }) => {
    await page.goto("/admin/analytics?tab=imports");

    // The panel reads /api/admin/memory and /api/admin/external-imports after
    // mount, and it is the only place in the console that reads either.
    await expect(page.getByTestId("admin-memory-import-panel")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Review outcomes and extraction runs" })
    ).toBeVisible();
    // The product funnel belongs to the other tab and is not fetched here.
    await expect(
      page.getByRole("heading", { name: "Go-live funnel and activation" })
    ).toHaveCount(0);

    // The §12.1 revocation control shares this tab, and it states the current
    // revocation state in a sentence rather than leaving it to be inferred
    // from an empty checkbox list.
    await expect(
      page.getByTestId("admin-memory-revocation-panel")
    ).toBeVisible();
    await expect(page.getByTestId("admin-memory-revocation-state")).toHaveText(
      /Nothing is revoked/
    );
  });

  test("users lists seeded accounts with their plan and risk state", async ({
    page,
  }) => {
    await page.goto("/admin/users");

    await expect(page.getByText(FIXTURE_CUSTOMERS.activePro.name)).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: `View details for ${FIXTURE_CUSTOMERS.disputedHold.email}`,
      })
    ).toBeVisible();
    // The disputed-hold customer is the one carrying debt, and the row says so.
    await expect(page.getByText("AI access held")).toBeVisible();
    await expect(page.getByText(/Debt 640 credits/)).toBeVisible();
  });

  test("the customer detail page renders plan, usage, credits, and timeline", async ({
    page,
  }) => {
    await page.goto(`/admin/users/${FIXTURE_CUSTOMERS.activePro.id}`);

    await expect(consoleHeading(page)).toHaveText("Customer detail");
    await expect(page.getByText(FIXTURE_CUSTOMERS.activePro.email)).toBeVisible();
    await expect(page.getByText("cus_e2e_active_pro")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Additional credit purchases" })
    ).toBeVisible();
    await expect(page.getByText(FIXTURE_CREDIT.packId).first()).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Recent conversations" })
    ).toBeVisible();
    await expect(
      page.getByText(FIXTURE_CONVERSATION.title).first()
    ).toBeVisible();
  });

  test("support's feedback tab shows open and resolved entries with a filter", async ({
    page,
  }) => {
    await page.goto("/admin/support?tab=feedback");

    await expect(consoleHeading(page)).toHaveText("Support");
    await expect(page.getByText(FIXTURE_FEEDBACK.open.message)).toBeVisible();
    await expect(page.getByText(FIXTURE_FEEDBACK.resolved.message)).toBeVisible();
    // The bounded read states its own scope rather than presenting itself as
    // every report ever filed.
    await expect(page.getByText(/Showing the \d+ most recent reports/)).toBeVisible();

    await page.getByRole("button", { name: "resolved", exact: true }).first().click();
    await expect(page.getByText(FIXTURE_FEEDBACK.resolved.message)).toBeVisible();
    await expect(page.getByText(FIXTURE_FEEDBACK.open.message)).toHaveCount(0);
  });

  test("support's privacy tab renders the data-rights queue", async ({ page }) => {
    await page.goto("/admin/support?tab=privacy");

    await expect(
      page.getByRole("heading", { name: "Data rights request queue" })
    ).toBeVisible();
    await expect(
      page.getByText(FIXTURE_PRIVACY_REQUEST.open.email).first()
    ).toBeVisible();
  });

  test("billing renders the plan catalogue and lifecycle counters", async ({
    page,
  }) => {
    await page.goto("/admin/billing");

    await expect(
      page.getByRole("heading", { name: "Refunds and cancellations split" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Plans, fixed market prices, Stripe IDs, and promotion codes",
      })
    ).toBeVisible();
    for (const plan of ["Free", "Pro", "Max"]) {
      await expect(page.getByRole("heading", { name: plan, exact: true })).toBeVisible();
    }
  });

  test("billing's promotions tab renders the code catalogue and its risk signals", async ({
    page,
  }) => {
    await page.goto("/admin/billing?tab=promotions");

    await expect(page.getByText(FIXTURE_PROMOTION.code).first()).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Promotion risk monitor" })
    ).toBeVisible();
    // Two risk flags were seeded on the single redemption.
    await expect(page.getByText(/abuse signal/).first()).toBeVisible();
    // The role matrix and administrator list that used to be rendered here as
    // well live only on /admin/admin-access now.
    await expect(
      page.getByRole("heading", { name: "Role matrix" })
    ).toHaveCount(0);
  });

  test("refunds separates the pending queue from reviewed requests", async ({
    page,
  }) => {
    await page.goto("/admin/refunds");

    await expect(page.getByRole("button", { name: "Pending 1" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approved 1" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Rejected 0" })).toBeVisible();
    await expect(page.getByText(FIXTURE_REFUNDS.pending.reason)).toBeVisible();
    // Credit-holding customers force the pre-approval review panel.
    await expect(
      page.getByText("Credit balance and cost review required")
    ).toBeVisible();

    await page.getByRole("button", { name: "All 2" }).click();
    await expect(page.getByText(FIXTURE_REFUNDS.approved.reason)).toBeVisible();
  });

  test("the credit ledger renders seeded grants and settlements", async ({
    page,
  }) => {
    await page.goto("/admin/credit-ledger");

    await expect(
      page.getByRole("heading", { name: "Recent credit movements" })
    ).toBeVisible();
    await expect(page.getByText("purchase_grant").first()).toBeVisible();
    await expect(page.getByText("settlement").first()).toBeVisible();
    await expect(
      page.getByText(FIXTURE_CUSTOMERS.activePro.email).first()
    ).toBeVisible();
    await expect(page.getByText(/newest entries only/)).toBeVisible();
  });

  test("providers renders health, usage sync, and per-model metrics", async ({
    page,
  }) => {
    await page.goto("/admin/providers");

    await expect(
      page.getByRole("heading", { name: "Provider health" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Sync provider usage APIs" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Failure rate and latency watch" })
    ).toBeVisible();
    await expect(page.getByText(FIXTURE_MODEL.enabled.name).first()).toBeVisible();
    // The model registry is no longer mounted a second time behind a tab here.
    await expect(
      page.getByRole("heading", { name: "Model catalogue and API configuration" })
    ).toHaveCount(0);
  });

  test("the model registry lists the seeded enabled and blocked models", async ({
    page,
  }) => {
    await page.goto("/admin/models");

    await expect(
      page.getByRole("heading", { name: "Model catalogue and API configuration" })
    ).toBeVisible();
    await expect(page.getByText(FIXTURE_MODEL.enabled.name).first()).toBeVisible();
    // The list opens on the Operational lifecycle view, so the blocked row is
    // one explicit selection away rather than on screen by default.
    await expect(page.getByText(FIXTURE_MODEL.disabled.name)).toHaveCount(0);
    await page
      .getByTestId("model-registry-lifecycle-filter")
      .selectOption("all");
    await expect(page.getByText(FIXTURE_MODEL.disabled.name).first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Edit ${FIXTURE_MODEL.enabled.name}` })
    ).toBeVisible();
  });

  test("providers' usage and cost tab renders provider spend alongside model metrics", async ({
    page,
  }) => {
    await page.goto("/admin/providers?tab=usage-cost");

    await expect(consoleHeading(page)).toHaveText("Providers");
    await expect(
      page.getByRole("heading", { name: "Failure rate and latency watch" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Sync provider usage APIs" })
    ).toBeVisible();
    await expect(page.getByText(FIXTURE_MODEL.enabled.name).first()).toBeVisible();
  });

  test("infrastructure renders its operations panel", async ({ page }) => {
    await page.goto("/admin/infrastructure");

    await expect(
      page.getByRole("heading", { name: "Railway, R2, and database operations" })
    ).toBeVisible();
  });

  test("automation's jobs tab renders seeded runs and their outcome", async ({
    page,
  }) => {
    await page.goto("/admin/automation?tab=jobs");

    await expect(consoleHeading(page)).toHaveText("Automation");
    await expect(
      page.getByRole("heading", { name: "Scheduled jobs" }).first()
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: FIXTURE_JOB_RUN.succeeded.label })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: FIXTURE_JOB_RUN.failed.label })
    ).toBeVisible();
    // The seeded runs are joined onto those cards, so "Never" would mean the
    // dashboard rendered without them.
    await expect(page.getByText("Last run:").first()).toBeVisible();
    await expect(page.getByText(/Consecutive failures: 1/).first()).toBeVisible();
  });

  test("automation's webhooks tab renders the billing event monitor", async ({
    page,
  }) => {
    await page.goto("/admin/automation?tab=webhooks");

    await expect(
      page.getByRole("heading", { name: "Billing event monitor" })
    ).toBeVisible();
    await expect(page.getByText(FIXTURE_WEBHOOK.failed.stripeEventId)).toBeVisible();
    await expect(page.getByRole("button", { name: "Reprocess" })).toBeVisible();
  });

  test("automation's reports tab is reachable on its own", async ({ page }) => {
    await page.goto("/admin/automation?tab=reports");

    // Reports had no navigation entry at all; it rendered underneath the
    // webhook table with nothing naming it.
    await expect(
      page.getByRole("heading", { name: "Operations report" })
    ).toBeVisible();
  });

  test("alerts renders the policy, the templates, and the delivery log", async ({
    page,
  }) => {
    await page.goto("/admin/alerts");

    await expect(
      page.getByRole("heading", { name: "Budget and incident thresholds" })
    ).toBeVisible();
    await expect(page.getByRole("textbox").first()).toHaveValue(
      FIXTURE_ALERT_POLICY.name
    );

    await page.goto("/admin/alerts?tab=templates");
    await expect(
      page.getByRole("heading", { name: "Templates and delivery tests" })
    ).toBeVisible();

    await page.goto("/admin/alerts?tab=deliveries");
    await expect(
      page.getByRole("heading", { name: "Notification delivery log" })
    ).toBeVisible();
    await expect(page.getByText(FIXTURE_NOTIFICATION.failed.title)).toBeVisible();
    await expect(page.getByRole("button", { name: "failed 1" })).toBeVisible();
  });

  test("platform settings renders the stored defaults", async ({ page }) => {
    await page.goto("/admin/platform");

    await expect(
      page.getByRole("heading", { name: "Product defaults and guest experience" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Operational feature controls" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save platform settings" })
    ).toBeVisible();
  });

  test("the audit log renders the seeded administrator action", async ({
    page,
  }) => {
    await page.goto("/admin/audit");

    await expect(
      page.getByRole("heading", { name: "Admin activity log" })
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: FIXTURE_AUDIT_LOG.summary }).first()
    ).toBeVisible();
    await expect(
      page.getByText(ADMIN_E2E_IDENTITIES.owner.email).first()
    ).toBeVisible();
    await expect(page.getByText(/most recent entries/)).toBeVisible();
  });

  test("retention renders its cleanup controls", async ({ page }) => {
    await page.goto("/admin/retention");

    await expect(
      page.getByRole("heading", { name: "Data retention operations" })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Dry run" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Execute cleanup" })
    ).toBeDisabled();

    // Every published policy is rendered, including the two that used to be
    // stated here and performed by nothing.
    await expect(
      page.getByText("Delete provider check records older than 30 days.")
    ).toBeVisible();
    await expect(
      page.getByText(/Delete alert delivery logs older than 90 days/)
    ).toBeVisible();
    // The audit log is a floor, not a queue: its number is history, and the
    // card must not offer it as work the cleanup will do.
    await expect(
      page.getByText("Beyond the floor", { exact: true })
    ).toBeVisible();
  });

  test("admin access lists the configured administrators and their roles", async ({
    page,
  }) => {
    await page.goto("/admin/admin-access");

    await expect(
      page.getByRole("heading", { name: "Least-privilege access" })
    ).toBeVisible();
    for (const key of ["owner", "billing", "support", "ops", "readonly"] as const) {
      await expect(
        page.getByText(ADMIN_E2E_IDENTITIES[key].email).first()
      ).toBeVisible();
    }

    await page.goto("/admin/admin-access?tab=integrity");
    await expect(
      page.getByRole("heading", { name: "Admin audit integrity" })
    ).toBeVisible();

    await page.goto("/admin/admin-access?tab=readiness");
    await expect(
      page.getByRole("heading", { name: "Recovery and access checkpoints" })
    ).toBeVisible();
  });

  test("the global search workspace finds a seeded customer", async ({
    page,
  }) => {
    await page.goto("/admin/search");

    await expect(consoleHeading(page)).toHaveText("Global search");
    await page
      .getByPlaceholder("Search email, Stripe ID, trace ID, refund, audit action...")
      .fill(FIXTURE_CUSTOMERS.disputedHold.email);
    await page.getByRole("button", { name: "Search", exact: true }).click();

    await expect(
      page.getByText(FIXTURE_CUSTOMERS.disputedHold.email).first()
    ).toBeVisible();
  });
});
