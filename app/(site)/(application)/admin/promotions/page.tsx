import { redirect } from "next/navigation";
import {
  ADMIN_LEGACY_ROUTES,
  adminRedirectTarget,
} from "@/lib/adminNavigation";

/**
 * Retired route, preserved as a redirect.
 *
 * Promotions are now the Billing page's Promotions & risk tab.
 */
export default async function AdminPromotionsRedirectPage({
  searchParams,
}: PageProps<"/admin/promotions">) {
  redirect(
    adminRedirectTarget(ADMIN_LEGACY_ROUTES["/admin/promotions"], await searchParams)
  );
}
