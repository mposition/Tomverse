export const dynamic = "force-dynamic";

import { AdminAgentTeamBoard } from "@/components/admin/AdminAgentTeamBoard";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AgentOfficePanel } from "@/components/admin/AgentOfficePanel";
import { readTeamBoard } from "@/lib/adminAgentTeamBoardRead";
import { getAdminLocale, getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAgentPageMessages } from "@/lib/adminMessages/agentPage";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { readAgentOfficeLiveRooms } from "@/lib/agentOfficeLiveRead";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAdminRole } from "@/lib/adminAuth";
import { agentOfficeCliMonitorCredential } from "@/lib/agentOfficeCliMonitor";

const TABS = adminNavItemTabs("office");

/**
 * The Agent office: the agent teams and the AMUX workers as a pixel office.
 *
 * The page reads each live room's operating state and the AMUX workers
 * (lib/agentOfficeLiveRead.ts) -- read only, and never what a team produced.
 * The card an AMUX worker holds and its CLI usage are read for the owner only,
 * as the owner-only AMUX card list shows them. Reading takes ordinary admin
 * authentication, which the console layout has established, and nothing on
 * the page writes.
 *
 * The section lives in `?tab=` (live office or dashboard). The office draws
 * its own tab strip and its tabs are links here; moving between them keeps the
 * panel mounted, and each navigation brings a fresh reading.
 *
 * Keyed by locale: the panel is built with the copy of the console's language,
 * so a language switch remounts it in the new language.
 */
export default async function AdminAgentOfficePage({ searchParams }: PageProps<"/admin/office">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  if (tab.id === "dashboard") {
    // The Team board reads the office's own rooms and draws them as cards; the live floor is the other tab.
    const [board, copy] = await Promise.all([readTeamBoard(), getAdminMessages(adminAgentPageMessages)]);
    return (
      <div className="flex min-w-0 flex-col gap-5">
        <p className="text-sm text-zinc-400">{copy.board.description}</p>
        <AdminPageTabs
          basePath="/admin/office"
          tabs={TABS}
          activeTabId={tab.id}
          label="Agents home sections"
          query={query}
          variant="underline"
        />
        <AdminAgentTeamBoard rooms={board.rooms} extras={board.extras} readAt={board.readAt} />
      </div>
    );
  }
  const [locale, session] = await Promise.all([getAdminLocale(), getServerSession(authOptions)]);
  // The card a worker holds and its usage are the owner's, as the AMUX card list is.
  const owner = getAdminRole(session) === "owner";
  const live = await readAgentOfficeLiveRooms(new Date(), { owner });
  return (
    <AgentOfficePanel
      key={locale}
      view="live"
      live={live}
      cliMonitorEnabled={owner && agentOfficeCliMonitorCredential() !== null}
    />
  );
}
