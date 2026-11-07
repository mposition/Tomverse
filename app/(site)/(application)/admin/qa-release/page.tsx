import { redirect } from "next/navigation";
import {
  ADMIN_LEGACY_ROUTES,
  ADMIN_QA_RELEASE_LEGACY_TABS,
  adminRedirectTarget,
} from "@/lib/adminNavigation";

/**
 * Retired route, preserved as a redirect.
 *
 * QA and release is the Release page (2026-11-07). The old page's four
 * sections each land on the Release tab, and the view of it, that now holds
 * them; a bare address opens the QA tab. Operator emails, commit statuses and
 * audit summaries link these addresses, so every one keeps working. The
 * destination decides access; this page never reads the session.
 */
export default async function AdminQaReleaseRedirectPage({
  searchParams,
}: PageProps<"/admin/qa-release">) {
  const query = await searchParams;
  const tab = typeof query.tab === "string" ? query.tab : undefined;
  const destination =
    (tab !== undefined ? ADMIN_QA_RELEASE_LEGACY_TABS[tab] : undefined) ??
    ADMIN_LEGACY_ROUTES["/admin/qa-release"];
  redirect(adminRedirectTarget(destination, query));
}
