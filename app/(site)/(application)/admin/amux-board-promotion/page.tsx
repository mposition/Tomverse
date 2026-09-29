import { redirect } from "next/navigation";
import {
  ADMIN_LEGACY_ROUTES,
  adminRedirectTarget,
} from "@/lib/adminNavigation";

/**
 * Retired route, preserved as a redirect.
 *
 * Manual promotion is now the AMUX Promotion page's Manual promotion section.
 * The destination is owner-only in the same way this page was: another role
 * is redirected and then answers 404 there.
 */
export default async function AdminAmuxBoardPromotionRedirectPage({
  searchParams,
}: PageProps<"/admin/amux-board-promotion">) {
  redirect(
    adminRedirectTarget(ADMIN_LEGACY_ROUTES["/admin/amux-board-promotion"], await searchParams)
  );
}
