export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminBillingLifecyclePanel } from "@/components/admin/AdminBillingLifecyclePanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { BillingAdminPanel } from "@/components/admin/BillingAdminPanel";
import {
  PromotionRiskPanel,
  type PromoRiskRow,
} from "@/components/admin/AdminRiskPanels";
import { PromotionDiagnosticsPanel } from "@/components/admin/PromotionDiagnosticsPanel";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { hasAdminPermission } from "@/lib/adminAuth";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminBillingMessages } from "@/lib/adminMessages/billing";
import { adminRiskPanelsMessages } from "@/lib/adminMessages/riskPanels";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { getAdminUserStats } from "@/lib/adminUsers";
import { authOptions } from "@/lib/auth";
import {
  getBillingPlans,
  getBillingPromotions,
  syncBillingDefaultsToDatabase,
  type BillingPromotionConfig,
} from "@/lib/billingConfig";
import { getBillingPriceCatalogWithMeta } from "@/lib/billingPriceCatalog";
import { parsePromotionRiskFlags } from "@/lib/billingPromotionSecurity";
import { prisma } from "@/lib/prisma";

const TABS = adminNavItemTabs("billing");

/** A read that failed is `null` -- never a zero or an empty list. */
const settledValue = <T,>(result: PromiseSettledResult<T>): T | null => {
  if (result.status === "fulfilled") return result.value;
  console.error("Failed to read billing console data:", result.reason);
  return null;
};

/**
 * Plans & pricing: the plan catalogue, the localized prices, promotions, and
 * the read-only promotion diagnostics -- one address each (`?tab=plans`,
 * `prices`, `promotions`, `diagnostics`). The editor used to switch between
 * its first three in component state, so the address said "plans" while the
 * screen showed prices; it now follows the URL (`initialTab`).
 *
 * The three editor tabs render the same panel in the same place, so a draft an
 * operator has not saved survives moving between them in one visit; it is
 * still lost on a reload, as it always was.
 *
 * Reads are settled one by one: a plan, price or promotion read that fails
 * shows an error instead of an editor that would save over unread values, and
 * a count that fails reads "Unavailable" rather than 0. Whether the role may
 * save is the route's own check (`billing:write`), read here so the save
 * button can say so before it is pressed.
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

  const [m, session] = await Promise.all([
    getAdminMessages(adminBillingMessages),
    getServerSession(authOptions),
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

  if (tab.id === "diagnostics") {
    // Read-only, and it loads nothing of its own: the promotion list is all it needs.
    const [promotionsRead] = await Promise.allSettled([getBillingPromotions()]);
    const promotions = settledValue(promotionsRead);
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs}
        {promotions ? (
          <PromotionDiagnosticsPanel promotions={promotions} />
        ) : (
          <AdminStateBlock
            kind="error"
            title={m.readFailed.promotionsTitle}
            detail={m.readFailed.promotionsDetail}
          />
        )}
      </div>
    );
  }

  const [plansRead, promotionsRead, pricingRead, statsRead] =
    await Promise.allSettled([
      getBillingPlans(),
      getBillingPromotions(),
      getBillingPriceCatalogWithMeta(),
      getAdminUserStats(),
    ]);
  const plans = settledValue(plansRead);
  const promotions = settledValue(promotionsRead);
  const pricing = settledValue(pricingRead);
  const userStats = settledValue(statsRead);

  if (!plans || !promotions || !pricing) {
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs}
        <AdminStateBlock
          kind="error"
          title={m.readFailed.title}
          detail={m.readFailed.detail}
        />
      </div>
    );
  }

  const refundReads =
    tab.id === "plans"
      ? await Promise.allSettled([
          prisma.refundRequest.count({ where: { status: "pending" } }),
          prisma.refundRequest.count({ where: { status: "approved" } }),
          prisma.refundRequest.count({ where: { status: "rejected" } }),
        ])
      : null;
  const refunds = refundReads?.map((result) => settledValue(result)) ?? null;

  let afterPromotions: React.ReactNode = null;
  if (tab.id === "promotions") {
    const risks = await loadPromoRisks(promotions).catch((error) => {
      console.error("Failed to read promotion risk signals:", error);
      return null;
    });
    afterPromotions = risks ? (
      <PromotionRiskPanel promoRisks={risks} />
    ) : (
      <AdminStateBlock
        kind="error"
        title={m.readFailed.riskTitle}
        detail={m.readFailed.riskDetail}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {tabs}
      {refunds ? (
        <AdminBillingLifecyclePanel
          activePaidUsers={userStats?.activePaidSubscriptions ?? null}
          activeSubscriptions={userStats?.activePaidSubscriptions ?? null}
          pendingRefunds={refunds[0]}
          approvedRefunds={refunds[1]}
          rejectedRefunds={refunds[2]}
          cancelAtPeriodEnd={userStats?.cancelingSubscriptions ?? null}
        />
      ) : null}
      <BillingAdminPanel
        plans={plans}
        promotions={promotions}
        priceCatalog={pricing.catalog}
        priceCatalogUpdatedAt={pricing.updatedAt}
        priceCatalogSource={pricing.source}
        canWrite={hasAdminPermission(session, "billing:write")}
        subscribers={{
          free: userStats?.freeUsers ?? null,
          pro: userStats?.proUsers ?? null,
          max: userStats?.maxUsers ?? null,
        }}
        initialTab={tab.id as "plans" | "prices" | "promotions"}
        afterPromotions={afterPromotions}
      />
    </div>
  );
}

/** The promotions an operator should look at, with the signal that says why. */
async function loadPromoRisks(promotions: BillingPromotionConfig[]): Promise<PromoRiskRow[]> {
  const riskLabels = (await getAdminMessages(adminRiskPanelsMessages)).promotionRisk.risk;
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

  return promotions
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
          ? riskLabels.abuseSignals(signals.total)
          : exhausted
            ? riskLabels.exhausted
            : nearingLimit
              ? riskLabels.nearLimit
              : promotion.discountPercent >= 80
                ? riskLabels.highDiscount
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
}
