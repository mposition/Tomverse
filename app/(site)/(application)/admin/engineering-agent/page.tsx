export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { AdminEngineeringAgentPanel } from "@/components/admin/AdminEngineeringAgentPanel";
import { AdminEngineeringOverview } from "@/components/admin/AdminEngineeringOverview";
import { AdminPageTabs, type AdminPageTabChip } from "@/components/admin/AdminPageTabs";
import { AdminViewSwitch } from "@/components/admin/AdminViewSwitch";
import { AdminAgentHeader } from "@/components/admin/ui/AdminAgentHeader";
import { hasAdminPermission } from "@/lib/adminAuth";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAgentPageMessages } from "@/lib/adminMessages/agentPage";
import { adminEngineeringAgentOverviewMessages } from "@/lib/adminMessages/engineeringAgentOverview";
import { adminUiMessages } from "@/lib/adminMessages/ui";
import {
  ADMIN_ENGINEERING_AGENT_LEGACY_TABS,
  adminNavItemTabs,
  adminRedirectTarget,
  resolveAdminTab,
  resolveAdminView,
} from "@/lib/adminNavigation";
import { formatAestDateTime } from "@/lib/adminUiCore";
import { authOptions } from "@/lib/auth";
import {
  readEngineeringAgentConsole,
  type EngineeringAgentConsoleSection,
} from "@/lib/engineeringAgentConsoleRead";
import { engineeringHeadStatus } from "@/lib/engineeringAgentOverviewCore";
import { readEngineeringAgentHead, readEngineeringOverviewBody } from "@/lib/engineeringAgentOverviewRead";

const TABS = adminNavItemTabs("engineering-agent");

/** Runs & PRs still holds the two records it replaced, as views of the tab. */
const RUN_VIEWS = ["runs", "pull-requests"] as const;

/**
 * The engineering agent's record and its person-owned controls
 * (docs/policy/engineering-agent.md §11, §12): the owner queue, runs, the
 * pull requests it bound, and its mode.
 *
 * Only the open section's rows are loaded, into the HTML. Reading takes
 * ordinary admin authentication, which the console layout has established;
 * deciding, acknowledging and changing the mode take `engineering-agent:write`
 * and a recent sign-in, and each route checks both again. Whether this viewer
 * may write travels with the payload, so a reader is not offered buttons that
 * can only refuse.
 *
 * Product research had a tab here until 2026-10-19; it is its own workspace
 * now, and the old tab link redirects there. Since 2026-11-07 the Runs & PRs
 * tab holds the runs and the pull requests as two views (the old
 * `?tab=pull-requests` opens the second). Every tab sits under the agent's
 * head, which reads the agent's own switch and halt; its auto-run mark is a
 * reading that links to Settings, where the real switch is.
 */
export default async function AdminEngineeringAgentPage({
  searchParams,
}: PageProps<"/admin/engineering-agent">) {
  const query = await searchParams;
  const legacy = typeof query.tab === "string" ? ADMIN_ENGINEERING_AGENT_LEGACY_TABS[query.tab] : undefined;
  if (legacy) redirect(adminRedirectTarget(legacy, query));
  const tab = resolveAdminTab(TABS, query.tab);
  const view = resolveAdminView(RUN_VIEWS, query.view);
  // The strip carries no `view`: switching tab starts that tab on its first view.
  const tabQuery = { ...query, view: undefined };

  const [head, agent, copy, ui] = await Promise.all([
    readEngineeringAgentHead(),
    getAdminMessages(adminAgentPageMessages),
    getAdminMessages(adminEngineeringAgentOverviewMessages),
    getAdminMessages(adminUiMessages),
  ]);
  const standing = engineeringHeadStatus(head);
  const decisions =
    head.kind === "observed" ? head.pending.t2Draft + head.pending.decision + head.pending.stateMismatch : 0;
  const chips: Record<string, AdminPageTabChip | undefined> = {
    queue: decisions > 0 ? { label: String(decisions), attention: true } : undefined,
  };
  const lastEnded = head.kind === "observed" && head.lastRun ? formatAestDateTime(head.lastRun.endedAt) : null;
  const statusLabel = standing.status === "frozen" ? copy.statusFrozen : agent.status[standing.status];

  const top = (
    <>
      <AdminAgentHeader
        team="engineering"
        name={copy.name}
        status={{ tone: standing.tone, label: statusLabel }}
        description={copy.description}
        meta={[
          { icon: "branch", label: copy.metaBranch },
          ...(head.kind === "observed"
            ? [{ icon: "clock" as const, label: lastEnded ? copy.metaLastRun(lastEnded) : copy.metaNoRun }]
            : []),
        ]}
        autoRun={{ state: standing.autoRun, href: "/admin/engineering-agent?tab=settings" }}
      />
      <AdminPageTabs
        basePath="/admin/engineering-agent"
        tabs={TABS}
        activeTabId={tab.id}
        label="Engineering agent sections"
        query={tabQuery}
        chips={chips}
        variant="underline"
      />
    </>
  );

  if (tab.id === "overview") {
    const body = await readEngineeringOverviewBody();
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {top}
        <AdminEngineeringOverview head={head} body={body} />
      </div>
    );
  }

  const section: EngineeringAgentConsoleSection =
    tab.id === "runs" ? (view === "pull-requests" ? "pull-requests" : "runs") : (tab.id as "queue" | "settings");
  const session = await getServerSession(authOptions);
  const initial = await readEngineeringAgentConsole(
    section,
    hasAdminPermission(session, "engineering-agent:write"),
  );

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {top}
      {tab.id === "runs" ? (
        <AdminViewSwitch
          basePath="/admin/engineering-agent"
          tabId="runs"
          query={tabQuery}
          activeId={view}
          views={[
            { id: "runs", label: ui.view.runs },
            { id: "pull-requests", label: ui.view.pullRequests },
          ]}
        />
      ) : null}
      {/* Keyed by section: a tab change remounts the panel with its own rows. */}
      <AdminEngineeringAgentPanel key={section} initial={initial} />
    </div>
  );
}
