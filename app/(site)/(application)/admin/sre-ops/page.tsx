export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminSreOpsPanel } from "@/components/admin/AdminSreOpsPanel";
import { hasAdminPermission } from "@/lib/adminAuth";
import { authOptions } from "@/lib/auth";
import { readOpsObserverAdminView } from "@/lib/opsObserverStore";

/**
 * The sre-ops agent's state chain and the owner's genesis
 * (docs/policy/sre-ops.md §8). Reading takes ordinary admin authentication,
 * which the console layout has established; approving a genesis takes
 * `sre-agent:write` (the owner) and a recent sign-in, checked by its route.
 * Whether this viewer may approve travels with the payload, so a reader is
 * not offered a button that can only refuse.
 */
export default async function AdminSreOpsPage() {
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
  return <AdminSreOpsPanel view={view} canApprove={hasAdminPermission(session, "sre-agent:write")} />;
}
