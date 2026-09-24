export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getServerSession } from "next-auth/next";

import { AmuxIntakePanel } from "@/components/admin/AmuxIntakePanel";
import { getAdminRole } from "@/lib/adminAuth";
import { authOptions } from "@/lib/auth";

export default async function AdminAmuxIntakePage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || getAdminRole(session) !== "owner") notFound();
  return <AmuxIntakePanel />;
}
