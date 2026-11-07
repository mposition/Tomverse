import {
  adminApi,
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
  FIXTURE_USAGE,
  FIXTURE_WEBHOOK,
  consoleHeading,
  expect,
  test,
  FIXTURE_SUPPRESSION,
} from "./support/console";
import { adminFixtureDatabase } from "./support/database";

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

  test("overview greets the operator, counts the waiting decisions, and shows recent admin activity", async ({
    page,
  }) => {
    await page.goto("/admin/overview");

    await expect(consoleHeading(page)).toHaveText("Today");
    await expect(page.getByTestId("admin-overview-greeting")).toBeVisible();
    // The decisions waiting on a person are counted from the seeded unclosed
    // feedback (three, the verified-trace report that arrived in `reviewing`
    // included), the pending refund and the open privacy request, so the line
    // is never "nothing is waiting" on this fixture.
    await expect(page.getByTestId("admin-overview-decision-line")).toContainText(
      /\d+ decisions? (is|are) waiting on you/
    );
    await expect(page.getByRole("heading", { name: "Decide now" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Waiting on you, by area" })
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Service status" })).toBeVisible();
    // The sidebar badges on real Postgres. Support: three unclosed reports
    // plus the open privacy request. The work queue: those three reports, the
    // refund and the privacy request. Both read one short while the reviewing
    // report went uncounted.
    await expect(
      page.getByRole("link", { name: /^Support, 4 awaiting action/ }).first()
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /^Decisions, 5 awaiting action/ }).first()
    ).toBeVisible();
    // Recent administrator activity replays the seeded audit row.
    await expect(page.getByText(FIXTURE_AUDIT_LOG.summary)).toBeVisible();
    // Each fact appears once: no second decisions list, no environment table.
    await expect(page.getByRole("heading", { name: "Decide now" })).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: "Environment health" })
    ).toHaveCount(0);
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

  test("the decision inbox lists every open item and links to the page that owns it", async ({
    page,
  }) => {
    await page.goto("/admin/work-queue");

    await expect(page.getByTestId("admin-decision-inbox")).toBeVisible();
    const pane = page.getByTestId("admin-decision-pane-detail");
    const open = async (text: string | RegExp, href: string) => {
      await page.getByTestId("admin-decision-row").filter({ hasText: text }).first().click();
      // The decision is made on the original screen: the inbox only links.
      await expect(pane.getByRole("link", { name: /^Handle it on/ })).toHaveAttribute("href", href);
    };
    // The refund, the privacy request and the open feedback all appear as
    // rows, each linking to the workspace that can act on it. Matched on the
    // row's own subject rather than on the email, which the seeded refund and
    // the seeded privacy request share.
    await open(new RegExp(`Refund request from ${FIXTURE_REFUNDS.pending.email}`), "/admin/refunds");
    await open(/export request from/, "/admin/support?tab=privacy");
    await open(new RegExp(FIXTURE_FEEDBACK.open.message.slice(0, 30)), "/admin/support?tab=feedback");
    // A report that arrived in review, untouched, is listed as well -- it is
    // the kind the server confirmed, and the kind the queue used to miss.
    await open(new RegExp(FIXTURE_FEEDBACK.autoReviewed.message.slice(0, 30)), "/admin/support?tab=feedback");
    // Only unclosed items belong in the inbox.
    await expect(page.getByText(FIXTURE_FEEDBACK.resolved.message)).toHaveCount(0);
    // The inbox no longer stacks whole management panels underneath itself.
    await expect(page.getByRole("heading", { name: "Scheduled jobs" })).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Cancellation and refund requests" })
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Unresolved support age" })
    ).toBeVisible();
    // An area tab is the same list through a filter.
    await page.getByRole("link", { name: /^System/ }).click();
    await expect(page).toHaveURL(/tab=system/);
    await expect(
      page.getByTestId("admin-decision-row").filter({ hasText: /export request from/ })
    ).toHaveCount(0);
  });

  test("the old approvals address opens the work queue", async ({ page }) => {
    await page.goto("/admin/approvals");

    await expect(page).toHaveURL("/admin/work-queue");
    await expect(consoleHeading(page)).toHaveText("Decisions");
    await expect(
      page.getByRole("heading", { name: "High-risk admin approvals" })
    ).toHaveCount(0);
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

  test("analytics opens on the usage report, with a period in the URL", async ({
    page,
  }) => {
    await page.goto("/admin/analytics");

    await expect(consoleHeading(page)).toHaveText("Metrics");
    // Streamed behind loading.tsx: wait for the one settled copy.
    await expect(page.getByTestId("admin-usage-analytics")).toHaveCount(1);
    const usage = page.locator("#main-content");
    await expect(usage.getByTestId("admin-usage-analytics")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Who is using Tomverse" })
    ).toHaveCount(1);
    // Today is the default period and is marked as the current one.
    await expect(
      page.getByRole("link", { name: "Today", exact: true })
    ).toHaveAttribute("aria-current", "page");
    await expect(usage.getByTestId("admin-usage-trend")).toBeVisible();
    await expect(usage.getByTestId("admin-usage-activity")).toBeVisible();
    // The model table and the distributions sit in the folded "More detail".
    await usage.getByText("More detail").click();
    await expect(usage.getByTestId("admin-usage-models")).toBeVisible();
    await expect(usage.getByTestId("admin-usage-segments")).toBeVisible();
    // A failed read renders a banner instead of the numbers; the seeded
    // database must never take that path.
    await expect(
      page.getByText("The usage report could not be read.", { exact: false })
    ).toHaveCount(0);

    await page.getByRole("link", { name: "Last 30 days", exact: true }).click();
    await expect(page).toHaveURL(/tab=usage&period=last30/);
    await expect(
      page.getByRole("link", { name: "Last 30 days", exact: true })
    ).toHaveAttribute("aria-current", "page");
    // The product funnel belongs to its own tab and is not read here.
    await expect(
      page.getByRole("heading", { name: "Go-live funnel and activation" })
    ).toHaveCount(0);
  });

  test("analytics renders the product funnel from seeded events", async ({
    page,
  }) => {
    await page.goto("/admin/analytics?tab=product");

    await expect(consoleHeading(page)).toHaveText("Metrics");
    await expect(page.getByRole("heading", { name: "From visit to payment" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Go-live funnel and activation" })
    ).toHaveCount(1);
    // The account-level funnel moved here from the promotions workspace.
    await expect(
      page.getByRole("heading", { name: "Launch conversion funnel" })
    ).toBeVisible();
    // The campaign list and the raw event table are folded below the charts.
    // The seeded landing_view events reach both, which is what distinguishes a
    // rendered dashboard from an empty one.
    await page.getByText("Top acquisition campaigns · 30d").click();
    await expect(
      page.getByText(FIXTURE_ANALYTICS.utmCampaign).first()
    ).toBeVisible();
    await page.getByText("Event funnel · last 30 days").click();
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

  test("analytics' AI Review tab reports insufficient_evidence rather than zero", async ({
    page,
  }) => {
    await page.goto("/admin/analytics?tab=ai-review");

    // Preparation intentionally hides observed scores until the operator
    // chooses the results view. Exercise that navigation, then the scorecard.
    await expect(page.getByTestId("ai-review-preparation")).toBeVisible();
    await expect(page.getByTestId("admin-ai-review-scorecard")).toHaveCount(0);
    await page.getByRole("link", { name: "Run results and operations" }).click();
    await expect(page).toHaveURL(/reviewView=reports/);
    await expect(page.getByTestId("admin-ai-review-scorecard")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "M5 scorecard" })
    ).toBeVisible();

    // The seeded database has no AI Review runs, and that is the state this
    // test is for: a scorecard whose sample is below the floor must say so.
    // A "0.0%" here would read as a measured failure of the feature, which is
    // the single thing docs/policy/ai-review-m5-quality-contract.md §8.3
    // forbids.
    await expect(page.getByText("insufficient_evidence").first()).toBeVisible();
    await expect(page.getByText("0.0%")).toHaveCount(0);

    // No reviewer pair is approved, so the register half says exactly that
    // rather than presenting an unmeasured zero as a clean bill.
    await expect(
      page.getByText("No approved reviewer pair")
    ).toBeVisible();
    await expect(
      page.getByText("Not measured — no approved pair")
    ).toBeVisible();
    await expect(
      page.getByText("The served reviewer pairs do not match the approved ones.")
    ).toBeVisible();

    // The product funnel belongs to another tab and is not fetched here.
    await expect(
      page.getByRole("heading", { name: "Go-live funnel and activation" })
    ).toHaveCount(0);
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

  test("a customer with usage history gets their buckets, not a load failure", async ({
    page,
  }) => {
    // The regression this covers: `ChatUsageBucket."count"` is BigInt, and a
    // `bigint` reaching `NextResponse.json()` throws, so the whole detail
    // response 500ed for any customer who had actually chatted. The panel
    // reported that as one sentence, which is why the surface has to be
    // asserted on the seeded figures rather than on the page merely loading.
    const detail = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/admin/users/${FIXTURE_CUSTOMERS.activePro.id}`) &&
        response.request().method() === "GET"
    );
    await page.goto(`/admin/users/${FIXTURE_CUSTOMERS.activePro.id}`);
    expect((await detail).status()).toBe(200);

    await expect(page.getByText("Failed to load user detail.")).toHaveCount(0);
    await expect(
      page.getByTestId("admin-user-detail-credits-today")
    ).toHaveText(String(FIXTURE_USAGE.creditsToday));
    // Past int4: the read carries the column's full width end to end.
    await expect(
      page.getByTestId("admin-user-detail-credits-month")
    ).toHaveText(String(FIXTURE_USAGE.creditsMonth));
    // The seeded conversation's two messages, counted in the customer's own
    // day window.
    await expect(
      page.getByTestId("admin-user-detail-messages-today")
    ).toHaveText("2");
    // Usage is only half the detail; the relations alongside it must render
    // too, so a green run means data reached the screen rather than an empty
    // panel that merely stopped erroring.
    await expect(
      page.getByText(FIXTURE_CONVERSATION.title).first()
    ).toBeVisible();
    await expect(page.getByText(FIXTURE_CREDIT.packId).first()).toBeVisible();
  });

  test("a customer with no usage history still reads zero", async ({ page }) => {
    // The other half of the same contract: an absent bucket used to be the
    // only path that worked, and it has to keep working.
    await page.goto(`/admin/users/${FIXTURE_CUSTOMERS.suspended.id}`);

    await expect(consoleHeading(page)).toHaveText("Customer detail");
    await expect(page.getByText("Failed to load user detail.")).toHaveCount(0);
    await expect(
      page.getByTestId("admin-user-detail-credits-today")
    ).toHaveText("0");
    await expect(
      page.getByTestId("admin-user-detail-credits-month")
    ).toHaveText("0");
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

  test("a finished report starts folded and opens from the keyboard with its actions", async ({
    page,
  }) => {
    await page.goto("/admin/support?tab=feedback");

    const entry = page
      .getByTestId("feedback-entry")
      .filter({ hasText: FIXTURE_FEEDBACK.resolved.message });
    const toggle = entry.getByTestId("feedback-fold-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(entry.getByRole("button", { name: "reviewing", exact: true })).toHaveCount(0);

    // A working report has no fold at all.
    const working = page
      .getByTestId("feedback-entry")
      .filter({ hasText: FIXTURE_FEEDBACK.open.message });
    await expect(working.getByTestId("feedback-fold-toggle")).toHaveCount(0);
    await expect(working.getByRole("button", { name: "reviewing", exact: true })).toBeVisible();

    // Focus stays on the same control through both changes.
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toBeFocused();
    await expect(entry.getByRole("button", { name: "reviewing", exact: true })).toBeEnabled();
    await expect(entry.getByText("Internal notes", { exact: true })).toBeVisible();

    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();
    await expect(entry.getByRole("button", { name: "reviewing", exact: true })).toHaveCount(0);
  });

  test("a search opens the finished report it found", async ({ page }) => {
    await page.goto(
      `/admin/support?tab=feedback&q=${encodeURIComponent(FIXTURE_FEEDBACK.resolved.id)}`
    );

    const entry = page.getByTestId("feedback-entry");
    await expect(entry).toHaveCount(1);
    await expect(entry.getByTestId("feedback-fold-toggle")).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    await expect(entry.getByRole("button", { name: "reviewing", exact: true })).toBeEnabled();
  });

  test("the feedback list does not scroll sideways at phone width, folded or open", async ({
    page,
  }) => {
    // An unbroken line is the worst case: a pasted URL, with nowhere to wrap.
    const unbroken = `https://example.com/${"x".repeat(400)}`;
    await adminFixtureDatabase().feedback.update({
      where: { id: FIXTURE_FEEDBACK.resolved.id },
      data: { message: unbroken, userAgent: unbroken, path: `/${"p".repeat(300)}` },
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/admin/support?tab=feedback");

    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
    const toggle = page
      .getByTestId("feedback-entry")
      .filter({ hasText: "https://example.com/" })
      .getByTestId("feedback-fold-toggle");

    await expect(toggle).toBeVisible();
    expect(await overflow()).toBe(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await overflow()).toBe(0);
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

  test("an audit row named in the URL opens from a directly-opened link", async ({
    page,
  }) => {
    // The integrity checker answers a failure with an id and nothing could take
    // it: the search did not look at `id`, and the list is the newest N anyway
    // while the checker stops at the oldest bad row. Resolved on the server, so
    // this works for a row the list does not hold.
    await page.goto(`/admin/audit?entry=${FIXTURE_AUDIT_LOG.id}`);

    const card = page.getByTestId("admin-audit-requested-entry");
    await expect(card).toBeVisible();
    await expect(card).toContainText(FIXTURE_AUDIT_LOG.id);
    await expect(card).toContainText(FIXTURE_AUDIT_LOG.summary);
  });

  test("a stale entry link says so instead of 404ing the workspace", async ({
    page,
  }) => {
    // The workspace exists and the operator is looking at it; what is missing is
    // one row. Answering 404 for the page would say the wrong thing.
    await page.goto("/admin/audit?entry=audit-no-such-entry");

    await expect(
      page.getByRole("heading", { name: "Admin activity log" })
    ).toBeVisible();
    await expect(
      page.getByTestId("admin-audit-requested-entry-missing")
    ).toContainText("audit-no-such-entry");
    await expect(page.getByTestId("admin-audit-requested-entry")).toHaveCount(0);
  });

  test("the audit search accepts an id, which is what the checker hands over", async ({
    page,
  }) => {
    await page.goto("/admin/audit");
    await page
      .getByPlaceholder(/Search/)
      .first()
      .fill(FIXTURE_AUDIT_LOG.id);
    await expect(
      page.getByRole("cell", { name: FIXTURE_AUDIT_LOG.summary }).first()
    ).toBeVisible();
  });

  test("the sending-domain tab reports what it could not read", async ({
    page,
  }) => {
    // No provider key in the fixture environment, which is the case worth
    // pinning: the screen has to say the provider was not reached and make no
    // claims, rather than deriving findings from an empty list and sending an
    // operator to re-create domains that already exist.
    await page.goto("/admin/email-policy?tab=domains");

    await expect(
      page.getByRole("heading", { name: "Sending domains" })
    ).toBeVisible();
    await expect(
      page.getByTestId("email-domain-configured-transactional")
    ).toContainText("tomverse.app");
    await expect(
      page.getByTestId("email-domain-configured-marketing")
    ).toContainText("not configured");
    await expect(page.getByTestId("email-domain-provider-error")).toBeVisible();
    await expect(page.getByTestId("email-domain-findings")).toBeEmpty();
  });

  test("the operator alert paths can be tested, and say what a pass means", async ({
    page,
  }) => {
    // These paths run only when something is wrong, so nothing exercises them
    // in ordinary operation -- which is how three of four senders stayed on the
    // old sending domain through a cutover
    // (docs/ops/email-sending-domains.md §1.2).
    await page.goto("/admin/alerts?tab=templates");

    const probe = page.getByTestId("operator-alert-probe");
    await expect(
      probe.getByRole("heading", { name: "Operator alert paths" })
    ).toBeVisible();
    await expect(page.getByTestId("operator-alert-probe-operational")).toBeVisible();
    await expect(page.getByTestId("operator-alert-probe-provider")).toBeVisible();

    // The limit of what a passing test proves is on screen, not in a comment.
    await expect(probe).toContainText("does not show that the condition");
  });

  test("the delivery history opens on what did not arrive, and says so", async ({
    page,
  }) => {
    // §9.5 keeps abandoned rows in place rather than moving them to a
    // dead-letter table, because moving them scatters the attempt count and the
    // error. Until this screen existed nothing read them back, so the reasoning
    // had never paid off -- and the badge §9.5 asks for had nowhere to lead.
    await page.goto("/admin/email-delivery");

    await expect(
      page.getByRole("heading", { name: "Deliveries" })
    ).toBeVisible();
    // A filtered view that does not name what it excludes reads as a total.
    await expect(page.getByTestId("email-delivery-scope")).toContainText(
      "abandoned"
    );
    await expect(
      page.getByTestId("email-delivery-filter-abandoned")
    ).toBeVisible();
  });

  test("the suppression tab says whose list it is not", async ({ page }) => {
    // Resend's suppression is account- and region-wide (§5.3.1), so an operator
    // who lifts an entry here and expects mail to flow is an operator who will
    // conclude the lift did not work.
    await page.goto("/admin/email-delivery?tab=suppressions");

    await expect(
      page.getByRole("heading", { name: "Suppressions" })
    ).toBeVisible();
    await expect(
      page.getByTestId("email-suppression-provider-notice")
    ).toContainText("not the provider");
  });

  test("addresses are masked by default, and revealing them is an owner action", async ({
    page,
    signInAs,
  }) => {
    // D10 (.github/audits/model-lifecycle-email-2026-08-22.md §21, decided
    // 2026-08-24): masked by default, revealed by a deliberate audited act.
    // Exposure is an event now, not a state.
    await signInAs("owner");
    // The suppressions tab, because the harness seeds a row there: the two
    // tabs share the same address component and the same reveal API, so this
    // exercises both through the browser without building an EmailDelivery's
    // event, policy version and template version in the fixture.
    await page.goto("/admin/email-delivery?tab=suppressions");

    // The mask is on screen and the address is not.
    await expect(page.locator("main")).toContainText("\u2022\u2022\u2022");
    await expect(page.locator("main")).not.toContainText(
      FIXTURE_SUPPRESSION.emailAddress
    );
    await expect(page.getByTestId("admin-address-revealed")).toHaveCount(0);

    const reveal = page.getByTestId("admin-reveal-addresses");
    await expect(reveal).toBeVisible();
    await reveal.click();

    await expect(page.locator("main")).toContainText(
      FIXTURE_SUPPRESSION.emailAddress,
      { timeout: 15_000 }
    );
    // The button is gone and the screen says the act was recorded, so nobody
    // has to wonder whether it was.
    await expect(page.getByTestId("admin-reveal-done")).toContainText(
      "audit log"
    );

    // And it does not survive the page. That is what makes it an event: there
    // is nothing to bookmark and nothing that keeps being true.
    await page.reload();
    await expect(page.locator("main")).not.toContainText(
      FIXTURE_SUPPRESSION.emailAddress
    );
  });

  test("support reads the screen and is told revealing is not theirs", async ({
    page,
    signInAs,
  }) => {
    await signInAs("support");
    await page.goto("/admin/email-delivery?tab=suppressions");

    // The control renders and says which it is. A button that vanishes for some
    // administrators is indistinguishable from a screen that has no such
    // feature, and the next question gets asked of whoever built it.
    await expect(
      page.getByTestId("admin-reveal-not-permitted")
    ).toContainText("owner or ops");
    await expect(page.getByTestId("admin-reveal-addresses")).toHaveCount(0);

    // And the server does not take their word for it either.
    const refused = await adminApi(page).post(
      "/api/admin/email-deliveries/reveal",
      { kind: "suppression", ids: ["any-id"] }
    );
    expect(refused.status()).toBe(403);
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
