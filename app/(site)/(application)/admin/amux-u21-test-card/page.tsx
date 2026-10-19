export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { notFound, redirect } from "next/navigation";

import { AmuxIntakePanel } from "@/components/admin/AmuxIntakePanel";
import { getAdminRole } from "@/lib/adminAuth";
import { hasRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { authOptions } from "@/lib/auth";

/** Optional owner UI for a single U21 test-card intake. The existing intake
 * API retains its separate code/env/confirmation gates and audit writer. */
export default async function AdminAmuxU21TestCardPage() {
  if (process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_TEST_CARD_INTAKE_UI !== "enabled")
    notFound();
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || getAdminRole(session) !== "owner") notFound();
  if (!hasRecentAdminAuthentication(session))
    redirect(adminRecentAuthenticationHref("/admin/amux-u21-test-card"));
  return <AmuxIntakePanel />;
}
