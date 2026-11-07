export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminPageTabs, type AdminPageTabChip } from "@/components/admin/AdminPageTabs";
import { OperatorPlaybooksPanel, SupportAgePanel } from "@/components/admin/AdminRiskPanels";
import { AdminWorkQueuePanel } from "@/components/admin/AdminWorkQueuePanel";
import { getAdminRole } from "@/lib/adminAuth";
import { feedbackSlaRows, loadFeedbackRows } from "@/lib/adminConsoleData";
import { DECISION_AREAS, type DecisionArea } from "@/lib/adminDecisionInbox";
import { loadAdminDecisionInbox } from "@/lib/adminDecisionInboxLoad";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminHomeMessages } from "@/lib/adminMessages/home";
import { adminWorkQueueMessages } from "@/lib/adminMessages/workQueue";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";
import { WORK_QUEUE_SOURCE_LIMIT } from "@/lib/adminWorkQueue";

const TABS = adminNavItemTabs("work-queue");

/**
 * Decisions: one inbox of what is waiting on a person, filtered by area.
 *
 * The inbox is read once (`lib/adminDecisionInboxLoad.ts`): the work queue's
 * rows, which carry a start time, and the badge counts for the agent and AMUX
 * approvals, which are counted but not listed anywhere a queue can read. The
 * area tabs are the same list through a filter, so a count on a tab and the
 * rows under it cannot disagree. It reads and links only: each decision is
 * made on the screen that owns it.
 *
 * Two-person approval is not a queue anymore: an eligible administrator
 * executes the action, and the audit log is the record. `/admin/approvals`
 * redirects here.
 */
export default async function AdminWorkQueuePage({ searchParams }: PageProps<"/admin/work-queue">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const now = new Date();
  const role = getAdminRole(await getServerSession(authOptions)) || "readonly";
  const [home, { queue: q }, inbox] = await Promise.all([
    getAdminMessages(adminHomeMessages),
    getAdminMessages(adminWorkQueueMessages),
    loadAdminDecisionInbox(role, now),
  ]);
  const d = home.decisions;

  const area: DecisionArea | null = (DECISION_AREAS as readonly string[]).includes(tab.id)
    ? (tab.id as DecisionArea)
    : null;

  const chips: Record<string, AdminPageTabChip> = { all: { label: String(inbox.total) } };
  for (const key of DECISION_AREAS) chips[key] = { label: String(inbox.byArea[key]) };

  const categoryName = (category: string) =>
    (q.categories as Readonly<Record<string, string>>)[category] ?? category;
  const notices = [
    inbox.queueUnread ? d.queueUnread : null,
    inbox.failedCategories.length > 0 ? d.failed(inbox.failedCategories.map(categoryName).join(", ")) : null,
    inbox.unreadSources.length > 0
      ? d.unreadSources(inbox.unreadSources.map((kind) => d.kinds[kind].screen).join(", "))
      : null,
  ].filter((text): text is string => text !== null);
  const truncatedNotice =
    inbox.truncatedCategories.length > 0
      ? d.truncated(WORK_QUEUE_SOURCE_LIMIT, inbox.truncatedCategories.map(categoryName).join(", "))
      : null;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/work-queue"
        tabs={TABS}
        activeTabId={tab.id}
        label="Decision sections"
        query={query}
        chips={chips}
      />
      <AdminWorkQueuePanel inbox={inbox} area={area} notices={notices} truncatedNotice={truncatedNotice} />
      {tab.id === "all" ? (
        <>
          <SupportAgePanel slaRows={feedbackSlaRows(await loadFeedbackRows(), now)} />
          <OperatorPlaybooksPanel />
        </>
      ) : null}
    </div>
  );
}
