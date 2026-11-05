export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { AdminBillingFinanceOpsDigestsPanel } from "@/components/admin/AdminBillingFinanceOpsDigestsPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminTrustSafetyDigestPanel } from "@/components/admin/AdminTrustSafetyDigestPanel";
import { readBillingFinanceOpsConsole } from "@/lib/billingFinanceOpsConsoleRead";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminTrustSafetyMessages } from "@/lib/adminMessages/trustSafety";
import { readTrustSafetyDigest, type TrustSafetyDigestView } from "@/lib/trustSafetyDigestRead";
import { hasAdminPermission } from "@/lib/adminAuth";
import {
  ADMIN_AGENT_DIGESTS_LEGACY_TABS,
  adminNavItemTabs,
  adminRedirectTarget,
  resolveAdminTab,
} from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";

const TABS = adminNavItemTabs("agent-digests");

/**
 * The common Agent digest area: one section per agent that stores digests.
 * QA and release, and CI admission, moved to /admin/qa-release; their old
 * links redirect there. Reading takes ordinary admin authentication, which
 * the console layout has established; recording a control revision takes
 * owner or ops and a recent sign-in, checked by its route.
 */
export default async function AdminAgentDigestsPage({ searchParams }: PageProps<"/admin/agent-digests">) {
  const query = await searchParams;
  const legacy = typeof query.tab === "string" ? ADMIN_AGENT_DIGESTS_LEGACY_TABS[query.tab] : undefined;
  if (legacy) redirect(adminRedirectTarget(legacy, query));
  const tab = resolveAdminTab(TABS, query.tab);
  const session = await getServerSession(authOptions);
  const canWrite = hasAdminPermission(session, "ops:write");

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/agent-digests"
        tabs={TABS}
        activeTabId={tab.id}
        label="Agent digest sections"
        query={query}
      />
      {tab.id === "trust-safety" ? (
        <TrustSafetySection session={session} refused={query.refused} />
      ) : (
        <AdminBillingFinanceOpsDigestsPanel key={tab.id} initial={await readBillingFinanceOpsConsole(canWrite)} />
      )}
    </div>
  );
}

/**
 * The trust-safety section.
 *
 * The page resolves the copy and the permission and hands them in, because the
 * section's own files may not import the locale helpers
 * (docs/policy/trust-safety-compliance-agent.md §5.6 closes their imports at
 * the six boundary modules and eight outside specifiers). The read is settled
 * on its own so a failure degrades this section instead of the workspace
 * (docs/ui-contracts/admin-console-ia.md rule 5), and the loss is reported
 * rather than absorbed.
 */
async function TrustSafetySection({
  session,
  refused,
}: {
  session: Awaited<ReturnType<typeof getServerSession>>;
  refused: string | string[] | undefined;
}) {
  const [messages, read] = await Promise.all([
    getAdminMessages(adminTrustSafetyMessages),
    (async () => {
      try {
        return await readTrustSafetyDigest();
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "admin_agent_digests_read_failed",
            read: "trust-safety",
            errorName: error instanceof Error ? error.name : "unknown",
          }),
        );
        return null;
      }
    })(),
  ]);

  return (
    <AdminTrustSafetyDigestPanel
      view={read as TrustSafetyDigestView | null}
      messages={messages as unknown as Record<string, string>}
      canWrite={hasAdminPermission(session, "trust-safety:write")}
      refusedCode={typeof refused === "string" ? refused : null}
    />
  );
}
