export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getServerSession } from "next-auth/next";

import { AmuxCardListPanel } from "@/components/admin/AmuxCardListPanel";
import { getAdminRole } from "@/lib/adminAuth";
import { listAmuxCardsForAdmin } from "@/lib/amux/adminCardList";
import { authOptions } from "@/lib/auth";

export default async function AdminAmuxCardsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || getAdminRole(session) !== "owner") notFound();
  const { rows, total, limit } = await listAmuxCardsForAdmin();
  return <AmuxCardListPanel rows={rows} total={total} limit={limit} />;
}
