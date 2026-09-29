import { redirect } from "next/navigation";
import {
  ADMIN_LEGACY_ROUTES,
  adminRedirectTarget,
} from "@/lib/adminNavigation";

/**
 * Retired route, preserved as a redirect.
 *
 * Source reconciliation is now the AMUX Backlog page's Source reconciliation section.
 * The destination is owner-only in the same way this page was: another role
 * is redirected and then answers 404 there.
 */
export default async function AdminAmuxReconciliationRedirectPage({
  searchParams,
}: PageProps<"/admin/amux-reconciliation">) {
  redirect(
    adminRedirectTarget(ADMIN_LEGACY_ROUTES["/admin/amux-reconciliation"], await searchParams)
  );
}
