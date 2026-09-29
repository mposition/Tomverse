import { redirect } from "next/navigation";
import {
  ADMIN_LEGACY_ROUTES,
  adminRedirectTarget,
} from "@/lib/adminNavigation";

/**
 * Retired route, preserved as a redirect.
 *
 * The intake screen is now the AMUX Backlog page's Intake section.
 * The destination is owner-only in the same way this page was: another role
 * is redirected and then answers 404 there.
 */
export default async function AdminAmuxIntakeRedirectPage({
  searchParams,
}: PageProps<"/admin/amux-intake">) {
  redirect(
    adminRedirectTarget(ADMIN_LEGACY_ROUTES["/admin/amux-intake"], await searchParams)
  );
}
