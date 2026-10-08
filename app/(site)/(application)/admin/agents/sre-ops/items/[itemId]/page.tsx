export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { AdminSreOpsDigestPanel } from "@/components/admin/AdminSreOpsDigestPanel";
import { AdminSreOpsItemPanel } from "@/components/admin/AdminSreOpsItemPanel";
import { readOpsObserverDigestItem } from "@/lib/opsObserverDigest";
import { readOpsObserverDelivery } from "@/lib/opsObserverStore";

/**
 * The target of every ops-observer notice link (docs/policy/sre-ops.md §3
 * rule 1): the path is fixed in scripts/ops-observer/content-guard-core.mjs
 * and the id is one the app minted -- a page message's reservation, or the
 * daily digest's kept item. Reading takes ordinary admin authentication,
 * which the console layout has established. An id that is neither -- or one
 * past its retention (§10) -- is a 404, as is any other unknown admin URL.
 */
export default async function AdminSreOpsItemPage({
  params,
}: PageProps<"/admin/agents/sre-ops/items/[itemId]">) {
  const { itemId } = await params;
  const delivery = await readOpsObserverDelivery(itemId);
  if (delivery) return <AdminSreOpsItemPanel view={delivery} />;
  const digest = await readOpsObserverDigestItem(itemId);
  if (digest) return <AdminSreOpsDigestPanel view={digest} />;
  notFound();
}
