export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminSreOpsPanel } from "@/components/admin/AdminSreOpsPanel";
import { AdminSreDaily, AdminSreOverviewSummary, AdminSreSettings } from "@/components/admin/AdminSreAgentScreens";
import { AdminAgentHeader } from "@/components/admin/ui/AdminAgentHeader";
import { hasAdminPermission } from "@/lib/adminAuth";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAgentPageMessages } from "@/lib/adminMessages/agentPage";
import { adminSreOpsAgentMessages } from "@/lib/adminMessages/sreOpsAgent";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { sreHeadStatus, summarizeSreDigest } from "@/lib/adminSreDailyCore";
import { formatAestDateTime } from "@/lib/adminUiCore";
import { authOptions } from "@/lib/auth";
import { readOpsObserverDigestItem, type OpsObserverDigestView } from "@/lib/opsObserverDigest";
import { OPS_OBSERVER_DIGEST_LIST_LIMIT, listOpsObserverDigests } from "@/lib/opsObserverDigestList";
import { readOpsObserverAdminView } from "@/lib/opsObserverStore";

const TABS = adminNavItemTabs("sre-ops");

/**
 * The sre-ops agent's state chain and the owner's genesis
 * (docs/policy/sre-ops.md §8). Reading takes ordinary admin authentication,
 * which the console layout has established; approving a genesis takes
 * `sre-agent:write` (the owner) and a recent sign-in, checked by its route.
 * Whether this viewer may approve travels with the payload, so a reader is
 * not offered a button that can only refuse.
 *
 * Three tabs (2026-11-07) under the agent's head. Overview is four numbers
 * and then the state chain and the genesis, as the page was. Daily report
 * lists the kept daily digests by date and opens one by the id its notice
 * links to (`?tab=daily&item=<id>`), through the same reader the notice
 * link's own page uses; with no id it shows the recent list. Settings says in
 * plain words what the mode and the contact path are; the mode itself is
 * still changed by approving a genesis on Overview.
 *
 * Every read fails on its own: a failed one is shown as unread, never as an
 * empty list or a quiet day.
 */
export default async function AdminSreOpsPage({ searchParams }: PageProps<"/admin/sre-ops">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const itemId = typeof query.item === "string" ? query.item : null;

  const [agent, copy] = await Promise.all([
    getAdminMessages(adminAgentPageMessages),
    getAdminMessages(adminSreOpsAgentMessages),
  ]);
  const [viewResult, listResult] = await Promise.allSettled([
    // A failed read is shown as one, not as a broken console: the screen
    // exists to explain why the agent is silent.
    readOpsObserverAdminView(),
    listOpsObserverDigests(),
  ]);
  const view =
    viewResult.status === "fulfilled"
      ? viewResult.value
      : (() => {
          const e = viewResult.reason as { name?: unknown; code?: unknown };
          console.error(JSON.stringify({
            event: "ops_observer_admin_read_failed",
            errorName: typeof e?.name === "string" ? e.name : null,
            errorCode: typeof e?.code === "string" ? e.code : null,
          }));
          return null;
        })();
  const digests = listResult.status === "fulfilled" ? listResult.value : null;
  if (!digests) console.warn({ event: "admin_sre_digest_list_read_failed" });
  const summaries = digests ? digests.map(summarizeSreDigest) : null;

  const standing = sreHeadStatus(view);
  const latest = summaries?.find((row) => row.createdAt) ?? null;
  const mode = view?.head?.mode ?? null;
  const strip = (
    <>
      <AdminAgentHeader
        team="sre"
        name={copy.name}
        status={{ tone: standing.tone, label: agent.status[standing.status] }}
        description={copy.description}
        meta={[
          ...(mode ? [{ icon: "shield" as const, label: copy.metaMode(mode) }] : []),
          ...(summaries
            ? [
                {
                  icon: "mail" as const,
                  label: latest
                    ? copy.metaReport(formatAestDateTime(latest.createdAt) ?? "-")
                    : copy.metaNoReport,
                },
              ]
            : []),
        ]}
        autoRun={{ state: standing.autoRun, href: "/admin/sre-ops?tab=settings" }}
      />
      <AdminPageTabs
        basePath="/admin/sre-ops"
        tabs={TABS}
        activeTabId={tab.id}
        label="SRE sections"
        query={query}
        variant="underline"
      />
    </>
  );

  if (tab.id === "daily") {
    // The open report: from the list when it is there, otherwise read on its
    // own (an older one a notice still links to). A failed or missing read is
    // shown as not found, never as a digest.
    let selected: OpsObserverDigestView | null = null;
    if (itemId) {
      selected =
        digests?.find((row) => row.id === itemId) ?? (await readOpsObserverDigestItem(itemId).catch(() => null));
    }
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {strip}
        <AdminSreDaily
          summaries={summaries}
          selected={selected}
          requestedId={itemId}
          limit={OPS_OBSERVER_DIGEST_LIST_LIMIT}
        />
      </div>
    );
  }
  if (tab.id === "settings") {
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {strip}
        <AdminSreSettings view={view} />
      </div>
    );
  }

  const session = await getServerSession(authOptions);
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {strip}
      <AdminSreOverviewSummary view={view} summaries={summaries} />
      <AdminSreOpsPanel view={view} canApprove={hasAdminPermission(session, "sre-agent:write")} />
    </div>
  );
}
