import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminUiMessages } from "@/lib/adminMessages/ui";

/**
 * The body of a tab the redesign has declared in the route table but has not
 * built yet. It says so plainly, and is never drawn for a section that already
 * has a screen: those keep the screen they had until their own is rebuilt.
 */
export async function AdminTabPlaceholder() {
  const m = await getAdminMessages(adminUiMessages);
  return <AdminStateBlock kind="empty" title={m.comingSoon.title} detail={m.comingSoon.detail} />;
}
