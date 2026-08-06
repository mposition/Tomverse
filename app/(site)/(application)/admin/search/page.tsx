export const dynamic = "force-dynamic";

import { AdminGlobalSearchPanel } from "@/components/admin/AdminGlobalSearchPanel";

/**
 * The global search workspace.
 *
 * It has no sidebar entry -- searching starts from the header control or
 * Ctrl/Cmd+K on every page -- but it is a real page with a real title.
 * `resolveAdminPageMeta()` lists it under `ADMIN_UNLISTED_PAGES` so the heading
 * reads "Global search"; it previously fell through to the first navigation
 * entry and was headed "Overview".
 */
export default function AdminSearchPage() {
  return <AdminGlobalSearchPanel />;
}
