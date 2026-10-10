export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getServerSession } from "next-auth/next";

import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AmuxBoardAutoPromotionPanel } from "@/components/admin/AmuxBoardAutoPromotionPanel";
import { AmuxV22PromotionControl } from "@/components/admin/AmuxV22PromotionControl";
import { AmuxBoardPromotionPanel } from "@/components/admin/AmuxBoardPromotionPanel";
import { AmuxBoardRecommendationPanel } from "@/components/admin/AmuxBoardRecommendationPanel";
import { amuxSwitchedTabStatuses, amuxTabChips } from "@/lib/adminAmuxTabStatus";
import { getAdminRole } from "@/lib/adminAuth";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAmuxWorkspaceMessages } from "@/lib/adminMessages/amuxWorkspace";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";

const TABS = adminNavItemTabs("amux-promotion");

/**
 * How a backlog card reaches Todo: the recommendation pool, manual promotion,
 * and limited automatic promotion.
 *
 * Three owner-only screens that used to be three unlisted routes
 * (`/admin/amux-board-recommendation`, `/admin/amux-board-promotion`,
 * `/admin/amux-board-auto-promotion`), each now a section. The panels are the
 * same components and send what they sent. Only the open section is rendered.
 *
 * Owner-only exactly as each screen was; the route table's `viewRoles` only
 * keeps the entry out of other roles' navigation.
 */
export default async function AdminAmuxPromotionPage({
  searchParams,
}: PageProps<"/admin/amux-promotion">) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || getAdminRole(session) !== "owner") notFound();
  const role = getAdminRole(session);
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const m = await getAdminMessages(adminAmuxWorkspaceMessages);
  const chips = amuxTabChips(
    amuxSwitchedTabStatuses(["recommendation", "promotion", "auto-promotion"]),
    m.status
  );

  const tabs = (
    <AdminPageTabs
      basePath="/admin/amux-promotion"
      tabs={TABS}
      activeTabId={tab.id}
      label="Promotion sections"
      query={query}
      role={role}
      chips={chips}
    />
  );

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {tabs}
      {tab.id === "promotion" ? (
        <AmuxBoardPromotionPanel />
      ) : tab.id === "auto-promotion" ? (
        <><AmuxV22PromotionControl /><AmuxBoardAutoPromotionPanel /></>
      ) : (
        <AmuxBoardRecommendationPanel />
      )}
    </div>
  );
}
