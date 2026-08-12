export const dynamic = "force-dynamic";

import { AdminRoutingShadowPanel } from "@/components/admin/AdminRoutingShadowPanel";

/**
 * Shadow routing, in its own workspace rather than as a tab on Models.
 *
 * Models is the registry -- what exists and how it is configured. This is a
 * measurement of a decision the server would make, which is a different
 * question with a different audience, and folding it into the registry page
 * would put an experiment's numbers beside an editable table.
 */
export default function AdminRoutingPage() {
  return <AdminRoutingShadowPanel />;
}
