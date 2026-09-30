export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getServerSession } from "next-auth/next";

import { AdminPromptRefinerShadowPanel } from "@/components/admin/AdminPromptRefinerShadowPanel";
import { getAdminRole } from "@/lib/adminAuth";
import { authOptions } from "@/lib/auth";

export default async function AdminPromptRefinerShadowPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || getAdminRole(session) !== "owner") notFound();
  return <AdminPromptRefinerShadowPanel />;
}
