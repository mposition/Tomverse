export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminEngineeringAgentPanel } from "@/components/admin/AdminEngineeringAgentPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminProductResearchPanel } from "@/components/admin/AdminProductResearchPanel";
import { hasAdminPermission } from "@/lib/adminAuth";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";
import {
  readEngineeringAgentConsole,
  type EngineeringAgentConsoleSection,
} from "@/lib/engineeringAgentConsoleRead";
import { readProductResearchConsole } from "@/lib/productResearchConsoleRead";

const TABS = adminNavItemTabs("engineering-agent");

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
 */
export default async function AdminEngineeringAgentPage({
  searchParams,
}: PageProps<"/admin/engineering-agent">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const session = await getServerSession(authOptions);

  // The product-research section is on this screen rather than its own
  // (docs/policy/product-research-agent.md §4: one shared agent area). It
  // shares nothing else: its own read, its own panel, and no control at all,
  // because that agent proposes nothing to decide.
  const productResearch = tab.id === "product-research";
  const initial = productResearch
    ? null
    : await readEngineeringAgentConsole(
        tab.id as EngineeringAgentConsoleSection,
        hasAdminPermission(session, "engineering-agent:write"),
      );
  const observations = productResearch ? await readProductResearchConsole() : null;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/engineering-agent"
        tabs={TABS}
        activeTabId={tab.id}
        label="Engineering agent sections"
        query={query}
      />
      {/* Keyed by section: a tab change remounts the panel with its own rows. */}
      {observations === null ? (
        <AdminEngineeringAgentPanel key={tab.id} initial={initial!} />
      ) : (
        <AdminProductResearchPanel key={tab.id} initial={observations} />
      )}
    </div>
  );
}
