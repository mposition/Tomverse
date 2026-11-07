import { getServerSession } from "next-auth/next";
import { notFound } from "next/navigation";
import { AdminUsersPanel } from "@/components/admin/AdminUsersPanel";
import { AdminReadFailed } from "@/components/admin/ui/AdminReadFailed";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminUsersMessages } from "@/lib/adminMessages/users";
import { authOptions } from "@/lib/auth";
import { getAdminUsersPage, getAdminUserStats } from "@/lib/adminUsers";
import { normalizeAdminUserSegment } from "@/lib/adminUserTypes";
import { getBillingPlans } from "@/lib/billingConfig";

/**
 * The Users list. The three reads are independent: a failed count leaves the
 * cards saying "Unavailable", a failed plan read leaves the credit bars off,
 * and only a failed list is an error -- it is never drawn as "no users".
 */
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
  const [pageRead, statsRead, plansRead] = await Promise.allSettled([
    getAdminUsersPage({ query: q, segment, cursor, take }),
    getAdminUserStats(),
    getBillingPlans(),
  ]);
  if (pageRead.status === "rejected") {
    console.warn({ event: "admin_users_read_failed", read: "list" });
    const m = await getAdminMessages(adminUsersMessages);
    return <AdminReadFailed title={m.toast.searchFailed} />;
  }
  const page = pageRead.value;
  const dailyCreditLimits =
    plansRead.status === "fulfilled"
      ? Object.fromEntries(plansRead.value.map((plan) => [plan.name, plan.dailyMessageLimit]))
      : {};
  return (
    <AdminUsersPanel
      rows={page.users}
      initialNextCursor={page.nextCursor}
      stats={statsRead.status === "fulfilled" ? statsRead.value : null}
      currentUserId={session.user.id}
      dailyCreditLimits={dailyCreditLimits}
      initialSegment={segment}
      initialQuery={q}
      initialPageSize={take}
      initialPageIndex={pageIndex}
      initialPageCursors={parsedCursors}
    />
  );
}
