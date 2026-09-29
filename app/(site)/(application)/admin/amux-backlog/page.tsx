export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getServerSession } from "next-auth/next";

import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AmuxBacklogMetadataPanel } from "@/components/admin/AmuxBacklogMetadataPanel";
import { AmuxBoardImportPanel } from "@/components/admin/AmuxBoardImportPanel";
import { AmuxIntakePanel } from "@/components/admin/AmuxIntakePanel";
import { AmuxReconciliationPanel } from "@/components/admin/AmuxReconciliationPanel";
import { amuxSwitchedTabStatuses, amuxTabChips } from "@/lib/adminAmuxTabStatus";
import { getAdminRole } from "@/lib/adminAuth";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAmuxWorkspaceMessages } from "@/lib/adminMessages/amuxWorkspace";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";

const TABS = adminNavItemTabs("amux-backlog");

/**
 * The AMUX backlog: what enters it and what is recorded about each card.
 *
 * Four owner-only screens that used to be four unlisted routes
 * (`/admin/amux-intake`, `/admin/amux-board-import`,
 * `/admin/amux-reconciliation`, `/admin/amux-backlog-metadata`), each now a
 * section. The panels are the same components; nothing about what they send
 * or when changed. Only the open section is rendered.
 *
 * Owner-only exactly as each screen was: the route table's `viewRoles` keeps
 * the entry out of other roles' navigation, and this check -- not the table --
 * is what refuses them.
 */
export default async function AdminAmuxBacklogPage({
  searchParams,
}: PageProps<"/admin/amux-backlog">) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || getAdminRole(session) !== "owner") notFound();
  const role = getAdminRole(session);
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const m = await getAdminMessages(adminAmuxWorkspaceMessages);
  const chips = amuxTabChips(
    amuxSwitchedTabStatuses(["intake", "import", "reconciliation", "metadata"]),
    m.status
  );

  const tabs = (
    <AdminPageTabs
      basePath="/admin/amux-backlog"
      tabs={TABS}
      activeTabId={tab.id}
      label="Backlog sections"
      query={query}
      role={role}
      chips={chips}
    />
  );

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {tabs}
      {tab.id === "import" ? (
        <AmuxBoardImportPanel />
      ) : tab.id === "reconciliation" ? (
        <AmuxReconciliationPanel />
      ) : tab.id === "metadata" ? (
        <AmuxBacklogMetadataPanel />
      ) : (
        <AmuxIntakePanel />
      )}
    </div>
  );
}
