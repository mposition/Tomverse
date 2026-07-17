import { notFound } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { AdminUsersPanel } from "@/components/admin/AdminUsersPanel";
import { authOptions } from "@/lib/auth";
import { getAdminUserStats } from "@/lib/adminUsers";
import { prisma } from "@/lib/prisma";

export default async function AdminUserDetailPage({
  params,
}: PageProps<"/admin/users/[userId]">) {
  const [{ userId }, session, stats, exists] = await Promise.all([
    params,
    getServerSession(authOptions),
    getAdminUserStats(),
    params.then(({ userId: id }) => prisma.user.findUnique({ where: { id }, select: { id: true } })),
  ]);
  if (!session?.user?.id || !exists) notFound();
  return (
    <AdminUsersPanel
      rows={[]}
      initialNextCursor={null}
      stats={stats}
      currentUserId={session.user.id}
      conversationCount={0}
      initialDetailUserId={userId}
      detailMode="page"
    />
  );
}
