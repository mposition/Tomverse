export const dynamic = "force-dynamic";

import { AdminModelRegistryPanel } from "@/components/admin/AdminModelRegistryPanel";

/**
 * The model registry, rendered in exactly one place.
 *
 * It was previously mounted twice: here, and again as the third tab of the
 * provider workspace's client-side tab strip -- two live copies of the same
 * editable table in the same session, each with its own fetch and its own
 * unsaved state.
 */
export default function AdminModelsPage() {
  return <AdminModelRegistryPanel />;
}
