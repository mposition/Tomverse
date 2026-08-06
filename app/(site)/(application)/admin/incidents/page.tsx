import { redirect } from "next/navigation";
import {
  ADMIN_LEGACY_ROUTES,
  adminRedirectTarget,
} from "@/lib/adminNavigation";

/**
 * Retired route, preserved as a redirect.
 *
 * Incidents are now the Providers page's Incidents & fallback tab.
 */
export default async function AdminIncidentsRedirectPage({
  searchParams,
}: PageProps<"/admin/incidents">) {
  redirect(
    adminRedirectTarget(ADMIN_LEGACY_ROUTES["/admin/incidents"], await searchParams)
  );
}
