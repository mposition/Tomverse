import { getServerSession } from "next-auth/next";
import { notFound } from "next/navigation";
import { AdminUsersPanel } from "@/components/admin/AdminUsersPanel";
import { authOptions } from "@/lib/auth";
import { getAdminUsersPage, getAdminUserStats } from "@/lib/adminUsers";
import { normalizeAdminUserSegment } from "@/lib/adminUserTypes";
import { prisma } from "@/lib/prisma";

export default async function AdminUsersPage({
  searchParams,
}: PageProps<"/admin/users">) {
  const [queryParams, session] = await Promise.all([searchParams, getServerSession(authOptions)]);
  if (!session?.user?.id) notFound();
  const q = (Array.isArray(queryParams.q) ? queryParams.q[0] : queryParams.q || "").trim().slice(0, 200);
  const segment = normalizeAdminUserSegment(Array.isArray(queryParams.segment) ? queryParams.segment[0] : queryParams.segment);
  const cursor = (Array.isArray(queryParams.cursor) ? queryParams.cursor[0] : queryParams.cursor || "").trim() || null;
  const requestedTake = Number(Array.isArray(queryParams.take) ? queryParams.take[0] : queryParams.take || 30);
  const take = requestedTake === 50 ? 50 : 30;
  const requestedPage = Number(Array.isArray(queryParams.page) ? queryParams.page[0] : queryParams.page || 1);
  const pageIndex = Number.isFinite(requestedPage) ? Math.max(0, Math.trunc(requestedPage) - 1) : 0;
  const rawCursors = (Array.isArray(queryParams.cursors) ? queryParams.cursors[0] : queryParams.cursors || "").slice(0, 2_000);
  const parsedCursors = rawCursors
    ? rawCursors.split(",").slice(0, 100).map((value) => value === "_" ? null : value)
    : [null];
  while (parsedCursors.length <= pageIndex) parsedCursors.push(null);
  if (cursor) parsedCursors[pageIndex] = cursor;
  const [page, stats, conversationCount] = await Promise.all([
    getAdminUsersPage({ query: q, segment, cursor, take }),
    getAdminUserStats(),
    prisma.conversation.count(),
  ]);
  return (
    <AdminUsersPanel
      rows={page.users}
      initialNextCursor={page.nextCursor}
      stats={stats}
      currentUserId={session.user.id}
      conversationCount={conversationCount}
      initialSegment={segment}
      initialQuery={q}
      initialPageSize={take}
      initialPageIndex={pageIndex}
      initialPageCursors={parsedCursors}
    />
  );
}
