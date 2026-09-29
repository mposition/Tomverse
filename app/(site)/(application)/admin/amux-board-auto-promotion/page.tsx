import { redirect } from "next/navigation";
import {
  ADMIN_LEGACY_ROUTES,
  adminRedirectTarget,
} from "@/lib/adminNavigation";

/**
 * Retired route, preserved as a redirect.
 *
 * Auto-promotion is now the AMUX Promotion page's Auto-promotion section.
 * The destination is owner-only in the same way this page was: another role
 * is redirected and then answers 404 there.
 */
export default async function AdminAmuxBoardAutoPromotionRedirectPage({
  searchParams,
}: PageProps<"/admin/amux-board-auto-promotion">) {
  redirect(
    adminRedirectTarget(ADMIN_LEGACY_ROUTES["/admin/amux-board-auto-promotion"], await searchParams)
  );
}
