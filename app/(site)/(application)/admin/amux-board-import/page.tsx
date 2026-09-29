import { redirect } from "next/navigation";
import {
  ADMIN_LEGACY_ROUTES,
  adminRedirectTarget,
} from "@/lib/adminNavigation";

/**
 * Retired route, preserved as a redirect.
 *
 * Catalog import is now the AMUX Backlog page's Catalog import section.
 * The destination is owner-only in the same way this page was: another role
 * is redirected and then answers 404 there.
 */
export default async function AdminAmuxBoardImportRedirectPage({
  searchParams,
}: PageProps<"/admin/amux-board-import">) {
  redirect(
    adminRedirectTarget(ADMIN_LEGACY_ROUTES["/admin/amux-board-import"], await searchParams)
  );
}
