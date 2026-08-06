import { redirect } from "next/navigation";
import {
  ADMIN_LEGACY_ROUTES,
  adminRedirectTarget,
} from "@/lib/adminNavigation";

/**
 * Retired route, preserved as a redirect.
 *
 * Scheduled jobs are now the Automation page's Scheduled jobs tab.
 */
export default async function AdminJobsRedirectPage({
  searchParams,
}: PageProps<"/admin/jobs">) {
  redirect(
    adminRedirectTarget(ADMIN_LEGACY_ROUTES["/admin/jobs"], await searchParams)
  );
}
