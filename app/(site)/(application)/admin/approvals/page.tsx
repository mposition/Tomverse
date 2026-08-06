import { redirect } from "next/navigation";
import {
  ADMIN_LEGACY_ROUTES,
  adminRedirectTarget,
} from "@/lib/adminNavigation";

/**
 * Retired route, preserved as a redirect.
 *
 * Approvals are now the Work queue page's Approvals tab.
 */
export default async function AdminApprovalsRedirectPage({
  searchParams,
}: PageProps<"/admin/approvals">) {
  redirect(
    adminRedirectTarget(ADMIN_LEGACY_ROUTES["/admin/approvals"], await searchParams)
  );
}
