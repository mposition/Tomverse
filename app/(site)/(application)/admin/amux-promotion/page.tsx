import { redirect } from "next/navigation";
import {
  ADMIN_LEGACY_ROUTES,
  adminRedirectTarget,
} from "@/lib/adminNavigation";

/**
 * Retired route, preserved as a redirect.
 *
 * Recommendation, manual promotion and legacy auto-promotion are the Legacy
 * tools of Safety & recovery (2026-11-07), whatever `?tab=` named. The
 * destination is owner-only in the same way this page was: another role is
 * redirected and then answers 404 there.
 */
export default async function AdminAmuxPromotionRedirectPage({
  searchParams,
}: PageProps<"/admin/amux-promotion">) {
  redirect(
    adminRedirectTarget(ADMIN_LEGACY_ROUTES["/admin/amux-promotion"], await searchParams)
  );
}
