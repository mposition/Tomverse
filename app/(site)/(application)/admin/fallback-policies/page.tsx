import { redirect } from "next/navigation";
import {
  ADMIN_LEGACY_ROUTES,
  adminRedirectTarget,
} from "@/lib/adminNavigation";

/**
 * Retired route, preserved as a redirect.
 *
 * Fallback policy is now the Providers page's Incidents & fallback tab.
 */
export default async function AdminFallbackPoliciesRedirectPage({
  searchParams,
}: PageProps<"/admin/fallback-policies">) {
  redirect(
    adminRedirectTarget(ADMIN_LEGACY_ROUTES["/admin/fallback-policies"], await searchParams)
  );
}
