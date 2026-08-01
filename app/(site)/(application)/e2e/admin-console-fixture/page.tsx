import { notFound } from "next/navigation";
import { AdminConsoleShell } from "@/components/admin/AdminConsoleShell";
import { AdminNotesBox } from "@/components/admin/AdminNotesBox";
import { AdminOperationalReadinessPanel } from "@/components/admin/AdminOperationalReadinessPanel";
import { AdminPrivacyRequestsPanel } from "@/components/admin/AdminPrivacyRequestsPanel";
import {
  RefundRequestsPanel,
  type RefundRequestRow,
} from "@/components/admin/RefundRequestsPanel";
import type { AdminSecurityUser } from "@/components/admin/AdminUserSecurityControls";
import { AdminProviderHealthPanel } from "@/components/admin/AdminProviderHealthPanel";
import { isE2EFixtureMode } from "@/lib/e2eTestMode";
import {
  providerHealthFixture,
  type ProviderHealthFixtureState,
} from "./providerHealthFixture";
import { AdminUserSecurityHarness } from "./AdminUserSecurityHarness";

export const dynamic = "force-dynamic";

/**
 * A Playwright-only mount of the admin console shell and the admin panels that
 * carry browser-level contracts.
 *
 * The real admin console needs an authorised administrator session and a
 * database, neither of which the fixture server has -- it runs `next start`
 * with `E2E_AUTH_BYPASS` and `E2E_DISABLE_DATABASE`, so `/admin/**` redirects
 * to sign-in and its pages cannot query Prisma. Without a mount point the
 * regressions this route exists to guard can only be asserted against source
 * text, and toast rendering, focus, hit testing and layout overflow are
 * exactly the things source text cannot show.
 *
 * Safety, and what this route deliberately does *not* do:
 *
 * - `isE2EFixtureMode()` is the same gate every other short-circuit uses: both
 *   flags AND a loopback `NEXTAUTH_URL` (`lib/e2eTestMode.ts`). It fails closed
 *   on every other combination -- see `tests/e2eTestMode.test.mjs` for the
 *   executed matrix, and `tests/e2e/admin-console-fixture-gate.spec.ts` for
 *   the real HTTP proof that a production-like server answers 404.
 * - It renders fixture props only. It grants nothing: every write still goes
 *   to the real `/api/admin/**` routes, which keep their own session,
 *   permission, rate-limit, reauthentication and two-person approval checks.
 *   A Playwright spec controls those responses with network interception, not
 *   by weakening the server.
 * - It is not linked from any navigation, and `app/robots.ts` excludes `/e2e`.
 * - `/api/ready` independently reports not-ready if the flags are ever set
 *   with `NODE_ENV=production` (`lib/securityEnvironment.ts`).
 *
 * The decision to keep it, the residual risk and the alternatives are recorded
 * in `docs/qa/admin-console-fixture-route.md`.
 */

const BASE_USER: AdminSecurityUser = {
  id: "qa-target-user",
  accountStatus: "active",
  accountDeletionRequestedAt: null,
  accountDeletionScheduledFor: null,
  accountSuspendedUntil: null,
  accountSuspensionReason: null,
  aiUsageRestricted: false,
  aiUsageRestrictedUntil: null,
  aiUsageRestrictionReason: null,
  securityIncidentNote: null,
  lastLoginAt: "2026-07-30T08:15:00.000Z",
  accounts: [{ provider: "google", providerAccountId: "qa-google-account" }],
  sessionCount: 2,
  timeZone: "UTC",
};

const STATES: Record<string, AdminSecurityUser> = {
  active: BASE_USER,
  pendingDeletion: {
    ...BASE_USER,
    accountStatus: "pending_deletion",
    accountDeletionRequestedAt: "2026-07-20T10:00:00.000Z",
    accountDeletionScheduledFor: "2026-08-19T10:00:00.000Z",
    aiUsageRestricted: true,
    aiUsageRestrictedUntil: null,
    aiUsageRestrictionReason: "Deletion requested by the customer",
  },
  suspended: {
    ...BASE_USER,
    accountStatus: "suspended",
    accountSuspendedUntil: "2026-08-05T00:00:00.000Z",
    accountSuspensionReason: "Confirmed payment fraud",
  },
};

/** One pending refund request, so the approval outcomes can be driven. */
const REFUND_ROWS: RefundRequestRow[] = [
  {
    id: "qa-refund-1",
    email: "customer@example.test",
    plan: "Pro",
    status: "pending",
    reason: "Charged after cancelling",
    adminNote: null,
    stripeCustomerId: "cus_qa",
    stripeSubscriptionId: "sub_qa",
    subscriptionStatus: "active",
    subscriptionBillingInterval: "monthly",
    subscriptionCurrentPeriodEnd: "2026-09-01T00:00:00.000Z",
    stripeRefundId: null,
    stripeRefundStatus: null,
    stripeChargeId: null,
    refundAmountCents: null,
    refundCurrency: null,
    requestedAt: "2026-07-30T09:00:00.000Z",
    reviewedAt: null,
  },
];

const single = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

export default async function AdminConsoleFixturePage({
  searchParams,
}: PageProps<"/e2e/admin-console-fixture">) {
  if (!isE2EFixtureMode()) notFound();
  const params = await searchParams;
  const initialUser = STATES[single(params.state) || "active"] || STATES.active;
  // `view` is opt-in per panel because several of them fetch on mount, and a
  // load failure raises a toast the toast-count specs would otherwise pick up.
  //   security (default) - the customer security controls only
  //   narrow             - adds the two other panels with a `datetime-local`
  //   toasts             - adds the panels whose result copy is under test
  //   provider-health    - the provider verification and recovery controls
  const view = single(params.view) || "security";
  // The verification and recovery controls read the provider's public status,
  // its failure count and its last verification result, so the state is chosen
  // per test rather than baked in. `canRunVerification` is the ops:write gate
  // the real console passes; the spec drives both values.
  const providerHealthState = (single(params.providerState) ||
    "incident") as ProviderHealthFixtureState;
  const canRunVerification = single(params.canVerify) !== "false";

  return (
    <AdminConsoleShell
      role="owner"
      user={{ name: "QA Administrator", email: "qa@tomverse.app", image: null }}
      environment="E2E"
      version="e2e"
      apiStatus="healthy"
      delayedJobCount={0}
      unacknowledgedAlertCount={0}
    >
      {/*
        Each panel is mounted in the same layout context the real console gives
        it, or the fixture would manufacture overflow that production does not
        have -- and hide overflow that it does. The security controls sit in
        AdminUsersPanel's two-column grid; the privacy and readiness panels sit
        in a `flex flex-col` stack on /admin (see app/(site)/(application)/admin/page.tsx).
      */}
      <div className="grid gap-4 lg:grid-cols-2">
        <AdminUserSecurityHarness initialUser={initialUser} />
      </div>
      {view === "narrow" ? (
        <section className="mt-4 flex flex-col gap-4">
          <AdminPrivacyRequestsPanel />
          <AdminOperationalReadinessPanel />
        </section>
      ) : null}
      {view === "provider-health" ? (
        <section className="mt-4 flex flex-col gap-4">
          <AdminProviderHealthPanel
            initialDashboard={providerHealthFixture(providerHealthState)}
            canManageCredits={false}
            canRunVerification={canRunVerification}
            providerFilter="perplexity"
          />
        </section>
      ) : null}
      {view === "toasts" ? (
        <section className="mt-4 flex flex-col gap-4">
          <RefundRequestsPanel rows={REFUND_ROWS} />
          <AdminNotesBox targetType="User" targetId="qa-target-user" />
        </section>
      ) : null}
    </AdminConsoleShell>
  );
}
