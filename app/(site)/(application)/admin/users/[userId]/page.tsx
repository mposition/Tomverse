export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getServerSession } from "next-auth/next";
import {
  ADMIN_USER_DETAIL_TABS,
  AdminUserDetailView,
  type AdminUserDetailTab,
  type AdminUserPlanLimits,
} from "@/components/admin/AdminUserDetailView";
import { hasAdminPermission } from "@/lib/adminAuth";
import { authOptions } from "@/lib/auth";
import { getBillingPlans } from "@/lib/billingConfig";
import { prisma } from "@/lib/prisma";

/**
 * One customer. The section is `?tab=` (declared with the route table as
 * `user-detail`); a stale or misspelt value opens the overview. The detail
 * itself is read in the browser from `/api/admin/users/:id`, so this page only
 * checks that the customer exists, reads the plan limits the credit figures are
 * measured against, and hands over the viewer's write access.
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
      canWrite={hasAdminPermission(session, "support:write")}
    />
  );
}
