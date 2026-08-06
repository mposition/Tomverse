import { redirect } from "next/navigation";
import {
  ADMIN_LEGACY_TAB_ROUTES,
  adminRedirectTarget,
} from "@/lib/adminNavigation";

/**
 * `/admin` itself is an entry point, not a workspace.
 *
 * It forwards to Overview, and `?tab=` -- the console's addressing scheme
 * before every workspace got its own route -- forwards to whatever that tab is
 * called today, carrying the rest of the query with it.
 */
export default async function AdminPage({
  searchParams,
}: PageProps<"/admin">) {
  const query = await searchParams;
  const rawTab = Array.isArray(query.tab) ? query.tab[0] : query.tab;
  const destination =
    (rawTab && ADMIN_LEGACY_TAB_ROUTES[rawTab]) || "/admin/overview";
  redirect(adminRedirectTarget(destination, query));
}
