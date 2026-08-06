import { redirect } from "next/navigation";
import {
  ADMIN_LEGACY_ROUTES,
  adminRedirectTarget,
} from "@/lib/adminNavigation";

/**
 * Retired route, preserved as a redirect.
 *
 * Webhooks are now the Automation page's Webhooks tab.
 */
export default async function AdminWebhooksRedirectPage({
  searchParams,
}: PageProps<"/admin/webhooks">) {
  redirect(
    adminRedirectTarget(ADMIN_LEGACY_ROUTES["/admin/webhooks"], await searchParams)
  );
}
