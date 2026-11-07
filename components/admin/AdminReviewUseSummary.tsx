import { AdminKpiCard } from "@/components/admin/ui/AdminKpiCard";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminHomeMessages } from "@/lib/adminMessages/home";
import type { ProductAnalyticsDashboard } from "@/lib/productAnalyticsDashboard";

/**
 * Three numbers above the AI Review tab: how many people started a review in
 * the last 30 days, how many finished, and how many then wanted to upgrade.
 *
 * `dashboard` is null when the product ledger could not be read; the numbers
 * are then unavailable rather than zero, and the run results below stay
 * usable. Only the ledger's own 30-day window exists for these, so there is no
 * period picker on this tab.
 */
export async function AdminReviewUseSummary({ dashboard }: { dashboard: ProductAnalyticsDashboard | null }) {
  const home = await getAdminMessages(adminHomeMessages);
  const r = home.metrics.aiReview;
  const review = dashboard?.available ? dashboard.reviewFunnel30d : null;
  if (!review) {
    return <AdminStateBlock kind="error" title={r.unread} />;
  }
  const number = new Intl.NumberFormat(home.intlLocale);
  return (
    <section className="flex flex-col gap-3" data-testid="admin-review-use">
      <div>
        <h2 className="text-base font-bold text-white">{r.title}</h2>
        <p className="mt-0.5 text-sm text-zinc-400">{r.description}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <AdminKpiCard label={r.started} value={number.format(review.startedUsers)} detail={r.startedDetail} />
        <AdminKpiCard
          label={r.completion}
          value={`${review.completionRate.toFixed(1)}%`}
          detail={r.completionDetail(review.completedUsers)}
        />
        <AdminKpiCard
          label={r.upgrade}
          value={`${review.upgradeIntentRate.toFixed(1)}%`}
          detail={r.upgradeDetail(review.upgradeIntentUsers)}
        />
      </div>
    </section>
  );
}
