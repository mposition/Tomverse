export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getServerSession } from "next-auth/next";
import {
  AdminUserDetailView,
  type AdminUserPlanLimits,
} from "@/components/admin/AdminUserDetailView";
import { ADMIN_USER_DETAIL_TABS, type AdminUserDetailTab } from "@/lib/adminUserDetailTabs";
import { hasAdminPermission } from "@/lib/adminAuth";
import { authOptions } from "@/lib/auth";
import { getBillingPlans } from "@/lib/billingConfig";
import { prisma } from "@/lib/prisma";

/**
 * One customer. The section is `?tab=` (declared with the route table as
 * `user-detail`); a stale or misspelt value opens the overview. The detail
 * itself is read in the browser from `/api/admin/users/:id`, so this page only
 * checks that the customer exists, reads the plan limits the credit figures are
 * measured against, and hands over the viewer's write access. Access is read
 * per kind of write, with the permission each route checks: billing writes are
 * `billing:write`, the security actions `support:write` or `ops:write`, and
 * unlinking a sign-in `user:delete`. The routes still refuse on their own.
 */
export default async function AdminUserDetailPage({
  params,
  searchParams,
}: PageProps<"/admin/users/[userId]">) {
  const [{ userId }, query, session] = await Promise.all([
    params,
    searchParams,
    getServerSession(authOptions),
  ]);
  const exists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!session?.user?.id || !exists) notFound();

  const requested = Array.isArray(query.tab) ? query.tab[0] : query.tab;
  const tab: AdminUserDetailTab =
    ADMIN_USER_DETAIL_TABS.find((id) => id === requested) ?? "overview";

  // A failed plan read only takes the limits off the credit figures.
  const [plansRead] = await Promise.allSettled([getBillingPlans()]);
  const planLimits: AdminUserPlanLimits =
    plansRead.status === "fulfilled"
      ? Object.fromEntries(
          plansRead.value.map((plan) => [
            plan.name,
            { daily: plan.dailyMessageLimit, monthly: plan.monthlyMessageLimit },
          ])
        )
      : {};

  return (
    <AdminUserDetailView
      userId={userId}
      tab={tab}
      currentUserId={session.user.id}
      planLimits={planLimits}
      access={{
        billing: hasAdminPermission(session, "billing:write"),
        security:
          hasAdminPermission(session, "support:write") || hasAdminPermission(session, "ops:write"),
        unlink: hasAdminPermission(session, "user:delete"),
      }}
    />
  );
}
