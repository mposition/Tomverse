export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { AdminEngineeringAgentPanel } from "@/components/admin/AdminEngineeringAgentPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminTabPlaceholder } from "@/components/admin/AdminTabPlaceholder";
import { AdminViewSwitch } from "@/components/admin/AdminViewSwitch";
import { hasAdminPermission } from "@/lib/adminAuth";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminUiMessages } from "@/lib/adminMessages/ui";
import {
  ADMIN_ENGINEERING_AGENT_LEGACY_TABS,
  adminNavItemTabs,
  adminRedirectTarget,
  resolveAdminTab,
  resolveAdminView,
} from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";
import {
  readEngineeringAgentConsole,
  type EngineeringAgentConsoleSection,
} from "@/lib/engineeringAgentConsoleRead";

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
 * `?tab=pull-requests` opens the second), and Overview is declared and waits
 * for its screen.
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
  const strip = (
    <AdminPageTabs
      basePath="/admin/engineering-agent"
      tabs={TABS}
      activeTabId={tab.id}
      label="Engineering agent sections"
      query={tabQuery}
    />
  );
  if (tab.id === "overview") {
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {strip}
        <AdminTabPlaceholder />
      </div>
    );
  }

  const section: EngineeringAgentConsoleSection =
    tab.id === "runs" ? (view === "pull-requests" ? "pull-requests" : "runs") : (tab.id as "queue" | "settings");
  const [session, ui] = await Promise.all([getServerSession(authOptions), getAdminMessages(adminUiMessages)]);
  const initial = await readEngineeringAgentConsole(
    section,
    hasAdminPermission(session, "engineering-agent:write"),
  );

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {strip}
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
