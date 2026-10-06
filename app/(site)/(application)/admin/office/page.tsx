import { AgentOfficePanel } from "@/components/admin/AgentOfficePanel";
import { getAdminLocale } from "@/lib/adminLocaleServer";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";

const TABS = adminNavItemTabs("office");

/**
 * The Agent office: a pixel office shell for the seven agent teams.
 *
 * It loads nothing. The office plays a demo day in the browser and links each
 * team to the console page that holds its record, so reading it takes
 * ordinary admin authentication -- which the console layout has established --
 * and nothing on it writes.
 *
 * The section lives in `?tab=` (live office or dashboard). The office draws
 * its own tab strip, as the original UI did, and its tabs are links here.
 * Moving between them is a client navigation that keeps the panel mounted, so
 * the demo day carries on across both sections.
 *
 * Keyed by locale: the demo engine is built once with the copy of the
 * console's language, so a language switch remounts the panel and starts a
 * new demo day in the new language rather than leaving the old one talking.
 */
export default async function AdminAgentOfficePage({ searchParams }: PageProps<"/admin/office">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const locale = await getAdminLocale();
  return <AgentOfficePanel key={locale} view={tab.id === "dashboard" ? "dashboard" : "live"} />;
}
