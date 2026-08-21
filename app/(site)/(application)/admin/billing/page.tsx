export const dynamic = "force-dynamic";

import { AdminBillingLifecyclePanel } from "@/components/admin/AdminBillingLifecyclePanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { BillingAdminPanel } from "@/components/admin/BillingAdminPanel";
import {
  PromotionRiskPanel,
  type PromoRiskRow,
} from "@/components/admin/AdminRiskPanels";
import { PromotionDiagnosticsPanel } from "@/components/admin/PromotionDiagnosticsPanel";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { getAdminUserStats } from "@/lib/adminUsers";
import {
  getBillingPlans,
  getBillingPromotions,
  syncBillingDefaultsToDatabase,
} from "@/lib/billingConfig";
import { getBillingPriceCatalogWithMeta } from "@/lib/billingPriceCatalog";
import { parsePromotionRiskFlags } from "@/lib/billingPromotionSecurity";
import { prisma } from "@/lib/prisma";

const TABS = adminNavItemTabs("billing");

/**
 * Billing owns the plan catalogue and, since the merge, promotions.
 *
 * `syncBillingDefaultsToDatabase()` runs here and nowhere else in the UI. It
 * used to run on *every* admin page render -- opening the audit log wrote plan
 * rows -- which is a write on a read path, on routes with no billing content at
 * all. It is a billing bootstrap, so it belongs on the billing route (and in
 * `/api/admin/billing`, which already calls it before reading or writing).
 */
export default async function AdminBillingPage({
  searchParams,
}: PageProps<"/admin/billing">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);

  await syncBillingDefaultsToDatabase();

  const [plans, promotions, pricing, userStats] = await Promise.all([
    getBillingPlans(),
    getBillingPromotions(),
    getBillingPriceCatalogWithMeta(),
    getAdminUserStats(),
  ]);

  const tabs = (
    <AdminPageTabs
      basePath="/admin/billing"
      tabs={TABS}
      activeTabId={tab.id}
      label="Billing sections"
      query={query}
    />
  );

  if (tab.id === "promotions") {
    const riskGroups = await prisma.billingPromotionRedemption.groupBy({
      by: ["promotionId", "riskFlags"],
      where: { riskFlags: { not: "[]" } },
      _count: { _all: true },
    });
    const signalsByPromotion = new Map<
      string,
      { total: number; sharedIp: number; sharedPaymentMethod: number }
    >();
    for (const row of riskGroups) {
      const current = signalsByPromotion.get(row.promotionId) || {
        total: 0,
        sharedIp: 0,
        sharedPaymentMethod: 0,
      };
      const flags = parsePromotionRiskFlags(row.riskFlags);
      current.total += row._count._all;
      if (flags.includes("shared_ip")) current.sharedIp += row._count._all;
      if (flags.includes("shared_payment_method")) {
        current.sharedPaymentMethod += row._count._all;
      }
      signalsByPromotion.set(row.promotionId, current);
    }

    const promoRisks: PromoRiskRow[] = promotions
      .map((promotion) => {
        const signals = signalsByPromotion.get(promotion.id) || {
          total: 0,
          sharedIp: 0,
          sharedPaymentMethod: 0,
        };
        const nearingLimit =
          promotion.maxRedemptions &&
          promotion.redeemedCount >= Math.floor(promotion.maxRedemptions * 0.8);
        const exhausted =
          promotion.maxRedemptions !== null &&
          promotion.redeemedCount >= promotion.maxRedemptions;
        const risk =
          signals.total > 0
            ? `${signals.total} abuse signal${signals.total === 1 ? "" : "s"}`
            : exhausted
              ? "exhausted"
              : nearingLimit
                ? "near limit"
                : promotion.discountPercent >= 80
                  ? "high discount"
                  : "";
        return {
          code: promotion.code,
          redeemedCount: promotion.redeemedCount,
          maxRedemptions: promotion.maxRedemptions,
          discountPercent: promotion.discountPercent,
          abuseSignalCount: signals.total,
          sharedIpSignalCount: signals.sharedIp,
          sharedPaymentMethodSignalCount: signals.sharedPaymentMethod,
          risk,
        };
      })
      .filter((promotion) => promotion.risk);

    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs}
        <BillingAdminPanel
          plans={plans}
          promotions={promotions}
          priceCatalog={pricing.catalog}
          priceCatalogUpdatedAt={pricing.updatedAt}
          priceCatalogSource={pricing.source}
          paidUserCount={userStats.activePaidSubscriptions}
          activeSubscriptionCount={userStats.activePaidSubscriptions}
          initialTab="promotions"
        />
        {/*
          Diagnostics sit under the catalogue editor, in the section that owns
          promotions. They are read-only and load nothing of their own here --
          the promotion list is already in hand for the editor above.
        */}
        <PromotionDiagnosticsPanel promotions={promotions} />
        <PromotionRiskPanel promoRisks={promoRisks} />
      </div>
    );
  }

  const [pendingRefunds, approvedRefunds, rejectedRefunds] = await Promise.all([
    prisma.refundRequest.count({ where: { status: "pending" } }),
    prisma.refundRequest.count({ where: { status: "approved" } }),
    prisma.refundRequest.count({ where: { status: "rejected" } }),
  ]);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {tabs}
      <AdminBillingLifecyclePanel
        activePaidUsers={userStats.activePaidSubscriptions}
        activeSubscriptions={userStats.activePaidSubscriptions}
        pendingRefunds={pendingRefunds}
        approvedRefunds={approvedRefunds}
        rejectedRefunds={rejectedRefunds}
        cancelAtPeriodEnd={userStats.cancelingSubscriptions}
      />
      <BillingAdminPanel
        plans={plans}
        promotions={promotions}
        priceCatalog={pricing.catalog}
        priceCatalogUpdatedAt={pricing.updatedAt}
        priceCatalogSource={pricing.source}
        paidUserCount={userStats.activePaidSubscriptions}
        activeSubscriptionCount={userStats.activePaidSubscriptions}
      />
    </div>
  );
}
