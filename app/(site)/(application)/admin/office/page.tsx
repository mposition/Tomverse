import { AgentOfficePanel } from "@/components/admin/AgentOfficePanel";
import { getAdminLocale } from "@/lib/adminLocaleServer";

/**
 * The Agent office: a pixel office shell for the seven agent teams.
 *
 * It loads nothing. The office plays a demo day in the browser and links each
 * team to the console page that holds its record, so reading it takes
 * ordinary admin authentication -- which the console layout has established --
 * and nothing on it writes.
 *
 * Keyed by locale: the demo engine is built once with the copy of the
 * console's language, and a language switch refreshes the route without
 * remounting it.
 */
export default async function AdminAgentOfficePage() {
  const locale = await getAdminLocale();
  return <AgentOfficePanel key={locale} />;
}
