export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getServerSession } from "next-auth/next";

import { AmuxBacklogMetadataPanel } from "@/components/admin/AmuxBacklogMetadataPanel";
import { getAdminRole } from "@/lib/adminAuth";
import { authOptions } from "@/lib/auth";

export default async function AdminAmuxBacklogMetadataPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || getAdminRole(session) !== "owner") notFound();
  return <AmuxBacklogMetadataPanel />;
}
