import { redirect } from "next/navigation";
import {
  ADMIN_LEGACY_ROUTES,
  adminRedirectTarget,
} from "@/lib/adminNavigation";

/**
 * Retired route, preserved as a redirect.
 *
 * The feedback inbox is now the Support page's Feedback tab.
 */
export default async function AdminFeedbackRedirectPage({
  searchParams,
}: PageProps<"/admin/feedback">) {
  redirect(
    adminRedirectTarget(ADMIN_LEGACY_ROUTES["/admin/feedback"], await searchParams)
  );
}
