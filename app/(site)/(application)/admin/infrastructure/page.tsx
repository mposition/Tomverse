export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminInfrastructurePanel } from "@/components/admin/AdminInfrastructurePanel";
import { getAdminRole } from "@/lib/adminAuth";
import { authOptions } from "@/lib/auth";

export default async function AdminInfrastructurePage() {
  const role = getAdminRole(await getServerSession(authOptions)) || "readonly";
  return (
    <AdminInfrastructurePanel
      canManageCosts={role === "owner" || role === "billing"}
    />
  );
}
