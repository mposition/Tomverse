export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminSreOpsDigestPanel } from "@/components/admin/AdminSreOpsDigestPanel";
import { AdminSreOpsPanel } from "@/components/admin/AdminSreOpsPanel";
import { AdminTabPlaceholder } from "@/components/admin/AdminTabPlaceholder";
import { hasAdminPermission } from "@/lib/adminAuth";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";
import { readOpsObserverDigestItem } from "@/lib/opsObserverDigest";
import { readOpsObserverAdminView } from "@/lib/opsObserverStore";

const TABS = adminNavItemTabs("sre-ops");

/**
 * The sre-ops agent's state chain and the owner's genesis
 * (docs/policy/sre-ops.md §8). Reading takes ordinary admin authentication,
 * which the console layout has established; approving a genesis takes
 * `sre-agent:write` (the owner) and a recent sign-in, checked by its route.
 * Whether this viewer may approve travels with the payload, so a reader is
 * not offered a button that can only refuse.
 *
 * Three tabs (2026-11-07). Overview is the state chain and the genesis, as the
 * page was. Daily report shows one kept daily digest, by the id its notice
 * links to (`?tab=daily&item=<id>`), the same reader the notice link's own
 * page uses; with no id it waits for the screen that lists them. Settings is
 * declared and waits for its screen.
 */
export default async function AdminSreOpsPage({ searchParams }: PageProps<"/admin/sre-ops">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const strip = (
    <AdminPageTabs
      basePath="/admin/sre-ops"
      tabs={TABS}
      activeTabId={tab.id}
      label="SRE sections"
      query={query}
    />
  );

  if (tab.id === "daily") {
    const itemId = typeof query.item === "string" ? query.item : null;
    // A failed or missing read is shown as the placeholder, not as a digest.
    const digest = itemId ? await readOpsObserverDigestItem(itemId).catch(() => null) : null;
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {strip}
        {digest ? <AdminSreOpsDigestPanel view={digest} /> : <AdminTabPlaceholder />}
      </div>
    );
  }
  if (tab.id === "settings") {
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {strip}
        <AdminTabPlaceholder />
      </div>
    );
  }

  const session = await getServerSession(authOptions);
  // A failed read is shown as one, not as a broken console: the screen exists
  // to explain why the agent is silent.
  const view = await readOpsObserverAdminView().catch((error: unknown) => {
    const e = error as { name?: unknown; code?: unknown };
    console.error(JSON.stringify({
      event: "ops_observer_admin_read_failed",
      errorName: typeof e?.name === "string" ? e.name : null,
      errorCode: typeof e?.code === "string" ? e.code : null,
    }));
    return null;
  });
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {strip}
      <AdminSreOpsPanel view={view} canApprove={hasAdminPermission(session, "sre-agent:write")} />
    </div>
  );
}
