import { redirect } from "next/navigation";
import {
  ADMIN_LEGACY_ROUTES,
  adminRedirectTarget,
} from "@/lib/adminNavigation";

/**
 * Retired route, preserved as a redirect.
 *
 * Card metadata is now the AMUX Backlog page's Card metadata section.
 * The destination is owner-only in the same way this page was: another role
 * is redirected and then answers 404 there.
 */
export default async function AdminAmuxBacklogMetadataRedirectPage({
  searchParams,
}: PageProps<"/admin/amux-backlog-metadata">) {
  redirect(
    adminRedirectTarget(ADMIN_LEGACY_ROUTES["/admin/amux-backlog-metadata"], await searchParams)
  );
}
