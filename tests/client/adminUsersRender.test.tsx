import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { AdminUsersPanel } from "@/components/admin/AdminUsersPanel";
import {
  AdminUserSecurityControls,
  type AdminSecurityUser,
} from "@/components/admin/AdminUserSecurityControls";
import { ADMIN_USER_DETAIL_TABS } from "@/lib/adminUserDetailTabs";
import { adminInitials } from "@/components/admin/ui/AdminInitialAvatar";
import { ADMIN_DETAIL_ROUTES } from "@/lib/adminNavigation";
import type { AdminUserRow, AdminUserStats } from "@/lib/adminUserTypes";

/**
 * The Users list and the security cards, as an operator first sees them.
 * Opening a card, the typed confirmations and every write are exercised by
 * tests/e2e/admin-user-security-controls.spec.ts; what is pinned here is what
 * is on the page before anything is clicked.
 */

const router: AppRouterInstance = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: () => {},
  bfcacheId: "admin-users-render-fixture",
};

const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/admin/users">
        <SearchParamsContext.Provider value={new URLSearchParams("")}>{node}</SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );

const stats: AdminUserStats = {
  generatedAt: "2026-11-07T03:00:00.000Z",
  totalAccounts: 312,
  freeUsers: 262,
  proUsers: 31,
  maxUsers: 13,
  activePaidSubscriptions: 44,
  testerPassUsers: 6,
  cancelingSubscriptions: 3,
  billingRiskUsers: 2,
  newUsers7d: 9,
  newUsers30d: 40,
  paidConversionRatePercent: 14.1,
};

const user = (overrides: Partial<AdminUserRow> = {}): AdminUserRow => ({
  id: "user-1",
  email: "user02@example.com",
  name: "Kim Seoyeon",
  plan: "Max",
  createdAt: "2026-08-02T00:00:00.000Z",
  subscriptionStatus: "active",
  subscriptionCurrentPeriodEnd: "2026-12-08T00:00:00.000Z",
  subscriptionBillingInterval: "monthly",
  subscriptionCancelAtPeriodEnd: false,
  stripeCustomerId: "cus_1",
  stripeSubscriptionId: "sub_1",
  timeZone: "Asia/Seoul",
  messagesToday: 12,
  creditsToday: 420,
  creditDebtCredits: 0,
  creditDebtCostMicroUsd: 0,
  billingRiskStatus: "normal",
  _count: { conversations: 4, accounts: 1, refundRequests: 0, promotionRedemptions: 0 },
  ...overrides,
});

const panel = (props: Partial<React.ComponentProps<typeof AdminUsersPanel>> = {}) =>
  wrap(
    <AdminUsersPanel
      rows={[user()]}
      initialNextCursor={null}
      stats={stats}
      currentUserId="operator"
      dailyCreditLimits={{ Max: 1000 }}
      {...props}
    />
  );

test("the five counts are filter buttons and say which one is on", () => {
  const html = panel({ initialSegment: "activePaid" });
  for (const label of ["All accounts", "Paid", "Tester Pass", "Canceling", "Billing risk"]) {
    assert.ok(html.includes(label), label);
  }
  assert.ok(html.includes(">312<") && html.includes(">44<") && html.includes(">6<"));
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
});

test("a count that could not be read says so instead of showing zero", () => {
  const html = panel({ stats: null });
  assert.equal((html.match(/data-unread="true"/g) || []).length, 5);
  assert.ok(html.includes("Unavailable"));
});

test("a row shows plan, subscription, credits against the plan limit, and a way in", () => {
  const html = panel();
  assert.ok(html.includes("Kim Seoyeon") && html.includes("user02@example.com"));
  assert.ok(html.includes('data-plan="Max"'));
  assert.ok(html.includes("Active"));
  assert.ok(html.includes("420 of 1,000"));
  assert.ok(html.includes('role="meter"') && html.includes('aria-valuenow="42"'));
  assert.ok(html.includes("2026-08-02"));
  assert.ok(html.includes('href="/admin/users/user-1"'));
});

test("a plan with no daily limit shows the number and no bar", () => {
  const html = panel({ dailyCreditLimits: {} });
  assert.ok(html.includes("420 credits"));
  assert.ok(!html.includes('role="meter"'));
});

test("billing trouble is spelled out on the row", () => {
  const html = panel({
    rows: [user({ creditDebtCredits: 380, billingRiskStatus: "disputed_hold", subscriptionCancelAtPeriodEnd: true })],
  });
  assert.ok(html.includes("Owes 380 credits"));
  assert.ok(html.includes("AI access held"));
  assert.ok(html.includes("Cancels at period end"));
});

test("an empty list says what to do, and the table is not drawn", () => {
  const html = panel({ rows: [] });
  assert.ok(html.includes("No users match"));
  assert.ok(!html.includes("<table"));
});

test("the same rows are also drawn as cards for a phone", () => {
  const html = panel();
  assert.ok(html.includes("<table") && html.includes("sm:hidden"));
});

const security = (overrides: Partial<AdminSecurityUser> = {}): AdminSecurityUser => ({
  id: "user-1",
  accountStatus: "active",
  accountSuspendedUntil: null,
  accountSuspensionReason: null,
  accountDeletionRequestedAt: null,
  accountDeletionScheduledFor: null,
  aiUsageRestricted: false,
  aiUsageRestrictedUntil: null,
  aiUsageRestrictionReason: null,
  securityIncidentNote: null,
  lastLoginAt: "2026-11-07T01:00:00.000Z",
  accounts: [{ provider: "google", providerAccountId: "g-1" }],
  sessionCount: 2,
  timeZone: "UTC",
  ...overrides,
});

const controls = (
  target: AdminSecurityUser,
  props: Partial<React.ComponentProps<typeof AdminUserSecurityControls>> = {}
) =>
  wrap(
    <AdminUserSecurityControls user={target} busy={false} onBusyChange={() => {}} onApplied={() => {}} {...props} />
  );

test("an unrestricted account reads as calm, with the actions closed", () => {
  const html = controls(security());
  assert.ok(html.includes("No restrictions right now"));
  for (const id of ["ai", "suspend", "sessions", "unlink", "delete"]) {
    assert.ok(html.includes(`data-testid="admin-security-card-${id}-toggle"`), id);
  }
  assert.equal((html.match(/aria-expanded="true"/g) || []).length, 0);
  // Nothing is typed into until a card is opened.
  assert.ok(!html.includes('data-testid="admin-security-reason"'));
  // Each card says what it will do before asking for anything.
  assert.ok(html.includes("new answers are blocked"));
  assert.ok(html.includes("They cannot sign in"));
  assert.ok(html.includes("Sign out of every device"));
});

test("a scheduled deletion opens the restore card first and hides suspension", () => {
  const html = controls(
    security({
      accountStatus: "pending_deletion",
      accountDeletionRequestedAt: "2026-11-01T00:00:00.000Z",
      accountDeletionScheduledFor: "2026-12-01T00:00:00.000Z",
    })
  );
  assert.ok(html.includes("This account has restrictions"));
  assert.ok(html.includes('data-testid="admin-security-deletion-schedule"'));
  assert.ok(html.includes('data-testid="admin-security-restore-group"'));
  assert.ok(html.includes('data-testid="admin-security-ticket"'));
  assert.ok(html.includes('data-testid="admin-security-restore"'));
  assert.ok(!html.includes('data-testid="admin-security-card-suspend"'));
  // The restore card has no expiry: restoring never takes one.
  assert.ok(!html.includes('data-testid="admin-security-until"'));
});

test("a restricted account offers the way back, not the same restriction again", () => {
  const html = controls(security({ accountStatus: "suspended", aiUsageRestricted: true }));
  assert.ok(html.includes("Lift the suspension"));
  assert.ok(html.includes("Restore AI use"));
  assert.ok(html.includes("AI restricted"));
});

test("a role that cannot write sees locked actions that name the access they need", () => {
  const html = controls(security({ accountStatus: "pending_deletion" }), { canWrite: false });
  assert.ok(html.includes("Needs support access"));
});

test("the step-up promise is on every confirming button before it is pressed", () => {
  const html = controls(security({ accountStatus: "pending_deletion" }));
  assert.ok(html.includes('data-step-up="true"'));
  assert.ok(html.includes("Sign in again and"));
});

test("the detail sections are the ones the route table declares", () => {
  const declared = ADMIN_DETAIL_ROUTES.find((route) => route.id === "user-detail");
  assert.deepEqual([...ADMIN_USER_DETAIL_TABS], declared?.tabs?.map((tab) => tab.id));
});

test("the server page reads the section list from a plain module, not from the client view", () => {
  // A server component handed a value exported by a "use client" file gets a
  // reference, not the array, so reading it throws on every customer page.
  const page = readFileSync("app/(site)/(application)/admin/users/[userId]/page.tsx", "utf8");
  assert.ok(page.includes('from "@/lib/adminUserDetailTabs"'));
  const fromView = page.match(/import \{([^}]*)\} from "@\/components\/admin\/AdminUserDetailView"/);
  assert.ok(fromView, "the page imports the view");
  assert.ok(!fromView[1].includes("ADMIN_USER_DETAIL_TABS"));
});

test("initials come from a name, else an email, else a question mark", () => {
  assert.equal(adminInitials("Mia Thompson", null), "MT");
  assert.equal(adminInitials(null, "user04@example.com"), "US");
  assert.equal(adminInitials(null, null), "?");
});
