import { redirect } from "next/navigation";
import {
  ADMIN_LEGACY_ROUTES,
  adminRedirectTarget,
} from "@/lib/adminNavigation";

/**
 * Retired route, preserved as a redirect.
 *
 * The recommendation pool is now the AMUX Promotion page's Recommendation pool section.
 * The destination is owner-only in the same way this page was: another role
 * is redirected and then answers 404 there.
 */
export default async function AdminAmuxBoardRecommendationRedirectPage({
  searchParams,
}: PageProps<"/admin/amux-board-recommendation">) {
  redirect(
    adminRedirectTarget(ADMIN_LEGACY_ROUTES["/admin/amux-board-recommendation"], await searchParams)
  );
}
