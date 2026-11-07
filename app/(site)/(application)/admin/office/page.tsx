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
 * The Agent office: a pixel office shell for the eight agent teams.
 *
 * The office plays a demo day in the browser and links each team to the
 * console page that holds its record. A room marked LIVE is the exception:
 * the page reads that team's operating state (lib/agentOfficeLiveRead.ts) --
 * read only, and never what the team produced -- and the demo leaves that room
 * alone. Reading takes ordinary admin authentication, which the console
 * layout has established, and nothing on the page writes.
 *
 * The section lives in `?tab=` (live office or dashboard). The office draws
 * its own tab strip, as the original UI did, and its tabs are links here.
 * Moving between them is a client navigation that keeps the panel mounted, so
 * the demo day carries on across both sections; each navigation brings a
 * fresh reading of the live rooms.
 *
 * Keyed by locale: the demo engine is built once with the copy of the
 * console's language, so a language switch remounts the panel and starts a
 * new demo day in the new language rather than leaving the old one talking.
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
  const [locale, live, session] = await Promise.all([
    getAdminLocale(), readAgentOfficeLiveRooms(), getServerSession(authOptions),
  ]);
  return (
    <AgentOfficePanel
      key={locale}
      view="live"
      live={live}
      cliMonitorEnabled={getAdminRole(session) === "owner" && agentOfficeCliMonitorCredential() !== null}
    />
  );
}
