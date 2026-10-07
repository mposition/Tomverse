export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { AdminSreOpsItemPanel } from "@/components/admin/AdminSreOpsItemPanel";
import { readOpsObserverDelivery } from "@/lib/opsObserverStore";

/**
 * The page message link's target (docs/policy/sre-ops.md §3 rule 1): the path
 * is fixed in scripts/ops-observer/content-guard-core.mjs and the id is the
 * reservation the advance minted. Reading takes ordinary admin
 * authentication, which the console layout has established. An id that is
 * not a reservation -- or one past its ninety days (§10) -- is a 404, as is
 * any other unknown admin URL.
 */
export default async function AdminSreOpsItemPage({
  params,
}: PageProps<"/admin/agents/sre-ops/items/[itemId]">) {
  const { itemId } = await params;
  const view = await readOpsObserverDelivery(itemId);
  if (!view) notFound();
  return <AdminSreOpsItemPanel view={view} />;
}
