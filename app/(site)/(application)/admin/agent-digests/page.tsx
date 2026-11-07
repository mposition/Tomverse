export const dynamic = "force-dynamic";

import type { Session } from "next-auth";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { AdminTrustSafetyDigestPanel } from "@/components/admin/AdminTrustSafetyDigestPanel";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import {
  ADMIN_REAUTHENTICATION_MODE_PARAM,
  ADMIN_RECENT_AUTH_MODE,
  adminReauthenticationHref,
} from "@/lib/adminReauthenticationCore";
import { adminTrustSafetyMessages } from "@/lib/adminMessages/trustSafety";
import { isTrustSafetyRefusalCode } from "@/lib/trustSafetyActivationCore";
import { readTrustSafetyDigest, type TrustSafetyDigestView } from "@/lib/trustSafetyDigestRead";
import { hasAdminPermission } from "@/lib/adminAuth";
import {
  ADMIN_AGENT_DIGESTS_DEFAULT_ROUTE,
  ADMIN_AGENT_DIGESTS_LEGACY_TABS,
  adminRedirectTarget,
} from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";

/**
 * What is left of the common Agent digest area: the Trust and safety digest.
 * QA and release, and CI admission, are the Release page, and the billing and
 * finance digest is the Billing and finance agent page (2026-11-07); their old
 * links, and a bare address, redirect (ADMIN_AGENT_DIGESTS_LEGACY_TABS). Only
 * `?tab=trust-safety` renders here: the activation step-up and the Agent
 * office link it, and it has no menu of its own yet. Reading takes ordinary
 * admin authentication, which the console layout has established.
 */
export default async function AdminAgentDigestsPage({ searchParams }: PageProps<"/admin/agent-digests">) {
  const query = await searchParams;
  // A repeated ?tab= names its first value, as resolveAdminTab reads it.
  const requestedTab = Array.isArray(query.tab) ? query.tab[0] : query.tab;
  const legacy = typeof requestedTab === "string" ? ADMIN_AGENT_DIGESTS_LEGACY_TABS[requestedTab] : undefined;
  if (legacy) redirect(adminRedirectTarget(legacy, query));
  if (requestedTab !== "trust-safety") redirect(adminRedirectTarget(ADMIN_AGENT_DIGESTS_DEFAULT_ROUTE, query));
  const session = await getServerSession(authOptions);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <TrustSafetySection session={session} refused={query.refused} />
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
  session: Session | null;
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

  // The step-up window, not console access: §6's refusal has to send the
  // operator to the clock that actually ran out, and back to this tab after.
  const reauthenticationHref = `${adminReauthenticationHref(
    "/admin/agent-digests?tab=trust-safety",
  )}&${ADMIN_REAUTHENTICATION_MODE_PARAM}=${ADMIN_RECENT_AUTH_MODE}`;

  return (
    <AdminTrustSafetyDigestPanel
      view={read as TrustSafetyDigestView | null}
      messages={messages as unknown as Record<string, string>}
      canWrite={hasAdminPermission(session, "trust-safety:write")}
      // Only a code the route can actually answer with: the panel interpolates
      // it into its copy, and the route's own rule is closed sets rather than
      // free text.
      refusedCode={isTrustSafetyRefusalCode(refused) ? (refused as string) : null}
      reauthenticationHref={reauthenticationHref}
    />
  );
}
