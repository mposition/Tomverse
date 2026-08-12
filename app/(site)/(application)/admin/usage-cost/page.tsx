import { redirect } from "next/navigation";
import {
  ADMIN_LEGACY_ROUTES,
  adminRedirectTarget,
} from "@/lib/adminNavigation";

/**
 * Retired route, preserved as a redirect.
 *
 * Usage and cost are now the Providers page's Usage & cost tab.
 */
export default async function AdminUsageCostRedirectPage({
  searchParams,
}: PageProps<"/admin/usage-cost">) {
  redirect(
    adminRedirectTarget(ADMIN_LEGACY_ROUTES["/admin/usage-cost"], await searchParams)
  );
}
