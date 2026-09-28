export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getServerSession } from "next-auth/next";

import { AmuxReconciliationPanel } from "@/components/admin/AmuxReconciliationPanel";
import { getAdminRole } from "@/lib/adminAuth";
import { authOptions } from "@/lib/auth";

export default async function AdminAmuxReconciliationPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || getAdminRole(session) !== "owner") notFound();
  return <AmuxReconciliationPanel />;
}
