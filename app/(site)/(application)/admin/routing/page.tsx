export const dynamic = "force-dynamic";

import Link from "next/link";

import { AdminRoutingShadowPanel } from "@/components/admin/AdminRoutingShadowPanel";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAmuxWorkspaceMessages } from "@/lib/adminMessages/amuxWorkspace";

/**
 * Shadow routing, in its own workspace rather than as a tab on Models.
 *
 * Models is the registry -- what exists and how it is configured. This is a
 * measurement of a decision the server would make, which is a different
 * question with a different audience, and folding it into the registry page
 * would put an experiment's numbers beside an editable table.
 *
 * AMUX assignment evidence used to sit above it. It moved to AMUX › Execution
 * with the rest of AMUX, and the line below says so, because runbooks written
 * before the move send operators here to find it.
 */
export default async function AdminRoutingPage() {
  const m = await getAdminMessages(adminAmuxWorkspaceMessages);
  return (
    <div className="space-y-6">
      <p className="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-300">
        {m.routingMoved.before}
        <Link
          href="/admin/amux-execution?tab=assignment"
          className="font-bold text-blue-300 underline underline-offset-4 hover:text-blue-200"
        >
          {m.routingMoved.link}
        </Link>
        {m.routingMoved.after}
      </p>
      <AdminRoutingShadowPanel />
    </div>
  );
}
