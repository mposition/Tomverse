import { notFound } from "next/navigation";
import { AdminConsoleShell } from "@/components/admin/AdminConsoleShell";
import type { AdminSecurityUser } from "@/components/admin/AdminUserSecurityControls";
import { isE2EFixtureMode } from "@/lib/e2eTestMode";
import { AdminUserSecurityHarness } from "./AdminUserSecurityHarness";

export const dynamic = "force-dynamic";

/**
 * A Playwright-only mount of the admin console shell and the customer security
 * controls.
 *
 * The real `/admin/users/:id` route needs an authorised administrator session
 * and a database, neither of which the fixture server has -- so the console
 * itself is unreachable under `next start` with E2E_AUTH_BYPASS and
 * E2E_DISABLE_DATABASE. Without a mount point the regressions this route
 * exists to guard (toasts that render nowhere, an expiry forwarded to
 * `restore_account`, errors that never reach the screen) can only be asserted
 * against source text, which is not a behaviour test.
 *
 * `isE2EFixtureMode()` is the same gate the other short-circuits use: both
 * flags plus a loopback NEXTAUTH_URL (lib/e2eTestMode.ts). It is a 404 on any
 * real deployment, and `/api/ready` independently reports not-ready if the
 * flags are ever set in production. Nothing here relaxes
 * `/api/admin/users/:id/security`, which keeps its own session, permission,
 * rate-limit, reauthentication and two-person approval checks.
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

export default async function AdminSecurityControlsHarnessPage({
  searchParams,
}: PageProps<"/e2e/admin-security-controls">) {
  if (!isE2EFixtureMode()) notFound();
  const params = await searchParams;
  const requested = Array.isArray(params.state) ? params.state[0] : params.state;
  const initialUser = STATES[requested || "active"] || STATES.active;

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
      <div className="grid gap-4 lg:grid-cols-2">
        <AdminUserSecurityHarness initialUser={initialUser} />
      </div>
    </AdminConsoleShell>
  );
}
