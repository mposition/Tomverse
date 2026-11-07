import { AdminFunnel } from "@/components/admin/ui/AdminFunnel";
import { AdminKpiCard } from "@/components/admin/ui/AdminKpiCard";
import { AdminShareList } from "@/components/admin/ui/AdminShareList";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminHomeMessages } from "@/lib/adminMessages/home";
import { adminProductAnalyticsMessages } from "@/lib/adminMessages/productAnalytics";
import { adminRiskPanelsMessages } from "@/lib/adminMessages/riskPanels";
import type { ProductAnalyticsDashboard } from "@/lib/productAnalyticsDashboard";

const eventGroups = [
  { label: "acquisition", events: ["landing_view", "marketing_touch", "cta_start_click", "pricing_view", "plan_selected"] },
  { label: "onboarding", events: ["onboarding_shown", "onboarding_completed", "onboarding_skipped"] },
  { label: "modelFinder", events: ["model_finder_viewed", "model_finder_started", "model_finder_completed", "model_finder_skipped", "recommended_model_accepted", "recommended_model_changed", "advanced_model_suggested", "advanced_model_selected"] },
  { label: "modelPicker", events: ["model_picker_opened", "model_picker_all_opened", "model_picker_search_used", "model_picker_filter_opened", "model_picker_filter_applied", "model_picker_selection_confirmed", "model_picker_max_reached", "model_picker_abandoned"] },
  { label: "firstExperience", events: ["chat_started", "first_response_completed"] },
  { label: "coreValue", events: ["multi_model_compare_completed"] },
  { label: "aiReview", events: ["comparison_review_viewed", "comparison_review_started", "comparison_review_completed", "comparison_review_failed"] },
  { label: "activationAction", events: ["followup_sent", "file_attached", "conversation_saved", "share_created"] },
  { label: "upgradeIntent", events: ["credit_limit_hit", "upgrade_prompt_view"] },
  { label: "signup", events: ["signup_page_view", "signup_started", "signup_completed"] },
  { label: "payment", events: ["checkout_started", "checkout_failed", "purchase_completed"] },
  { label: "retention", events: ["return_day_1", "return_day_7", "subscription_cancelled"] },
] as const;

const ga4KeyEventPolicy = [
  { event: "checkout_started", purpose: "tomverseFunnel", keyEvent: "no" },
  { event: "begin_checkout", purpose: "ga4Ecommerce", keyEvent: "no" },
  { event: "purchase_completed", purpose: "tomverseLedgerOnly", keyEvent: "no" },
  { event: "purchase", purpose: "ga4RevenueAds", keyEvent: "primary" },
] as const;

/** The account-level numbers behind the launch funnel (whole database, not a window). */
export type LaunchFunnelNumbers = {
  totalUsers: number;
  usersWithConversations: number;
  checkoutStarted: number;
  paidUsers: number;
};

function Disclosure({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
      <summary className="cursor-pointer list-none text-sm font-bold text-zinc-100 [&::-webkit-details-marker]:hidden">
        {summary}
      </summary>
      <div className="mt-4">{children}</div>
    </details>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-950/40 px-4 py-3">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums text-white">{value}</p>
      <p className="text-xs leading-5 text-zinc-500">{detail}</p>
    </div>
  );
}

/**
 * The product tab: the numbers that say whether people get from a visit to a
 * first answer to a payment, where sign-ups came from, and how AI Review fares
 * in that funnel.
 *
 * Everything is the last 30 days (the ledger's window), so there is no period
 * picker here. The raw event table, the Google Analytics delivery settings and
 * the campaign lists are kept in folded sections below the charts. A funnel
 * step with no events stays visible as "no events yet": an empty step is a
 * finding, not something to hide.
 */
export async function AdminProductAnalyticsPanel({
  dashboard,
  launch,
}: {
  dashboard: ProductAnalyticsDashboard;
  launch: LaunchFunnelNumbers;
}) {
  const [m, home, risk] = await Promise.all([
    getAdminMessages(adminProductAnalyticsMessages),
    getAdminMessages(adminHomeMessages),
    getAdminMessages(adminRiskPanelsMessages),
  ]);
  const p = home.metrics.product;
  const counts = new Map(dashboard.funnel30d.map((item) => [item.eventName, item.count]));
  const count = (event: string) => counts.get(event) ?? 0;
  const touch = dashboard.touchAttribution30d;
  const number = new Intl.NumberFormat(home.intlLocale);
  const percent = new Intl.NumberFormat(home.intlLocale, { style: "percent", maximumFractionDigits: 1 });

  const steps = [
    { key: "visit", label: p.funnelSteps.visit, value: count("landing_view") },
    { key: "signup", label: p.funnelSteps.signup, value: count("signup_completed") },
    { key: "firstAnswer", label: p.funnelSteps.firstAnswer, value: count("first_response_completed") },
    { key: "returned", label: p.funnelSteps.returned, value: count("return_day_7") },
    { key: "paid", label: p.funnelSteps.paid, value: count("purchase_completed") },
  ].map((step) => ({ ...step, valueLabel: number.format(step.value) }));

  const launchSteps = [
    { key: "accounts", label: risk.funnel.accounts, value: launch.totalUsers },
    { key: "chat", label: risk.funnel.usedChat, value: launch.usersWithConversations },
    { key: "checkout", label: risk.funnel.checkoutStarted, value: launch.checkoutStarted },
    { key: "paid", label: risk.funnel.paidUsers, value: launch.paidUsers },
  ].map((step) => ({ ...step, valueLabel: number.format(step.value) }));

  // Sign-ups by where they came from: the recorded touches summed by source.
  const bySource = new Map<string, { source: string; medium: string; count: number }>();
  for (const channel of touch.signups.channels) {
    const key = `${channel.source}/${channel.medium}`;
    const row = bySource.get(key) ?? { source: channel.source, medium: channel.medium, count: 0 };
    row.count += channel.count;
    bySource.set(key, row);
  }
  const sourceRows = [...bySource.values()].sort((left, right) => right.count - left.count).slice(0, 6);
  const review = dashboard.reviewFunnel30d;
  // A rate over nobody is not 0.0%: that would read as a measured failure.
  const reviewRate = (rate: number) => (review.startedUsers > 0 ? `${rate.toFixed(1)}%` : p.noRate);

  return (
    <section className="flex min-w-0 flex-col gap-5" data-testid="admin-product-analytics">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="sr-only">{m.title}</h2>
        <p className="max-w-3xl text-sm leading-6 text-zinc-400">{m.activationDefinitionLabel}{m.activationDefinition}</p>
        <div className="flex items-center gap-2">
          <AdminStatusChip tone="info">{p.windowChip}</AdminStatusChip>
          <AdminStatusChip tone={dashboard.available ? "ok" : "warn"}>
            {dashboard.available ? m.ledgerReady : m.migrationRequired}
          </AdminStatusChip>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AdminKpiCard
          label={p.northStar}
          value={number.format(dashboard.weeklyActiveComparisonUsers)}
          detail={p.northStarDetail}
        />
        <AdminKpiCard
          label={p.activation}
          value={dashboard.signupUsers30d > 0 ? `${dashboard.activationRate30d.toFixed(1)}%` : p.noRate}
          detail={p.activationDetail(dashboard.activatedUsers30d, dashboard.signupUsers30d)}
        />
        <AdminKpiCard label={p.day1} value={number.format(dashboard.returnDay1Users30d)} detail={p.returnDetail} />
        <AdminKpiCard label={p.day7} value={number.format(dashboard.returnDay7Users30d)} detail={p.returnDetail} />
      </div>

      <AdminTile title={p.funnelTitle} description={p.funnelDescription}>
        {steps.every((step) => step.value === 0) ? (
          <AdminStateBlock kind="empty" title={p.funnelNone} />
        ) : (
          <AdminFunnel steps={steps} rateLabel={(rate) => p.funnelRate(percent.format(rate))} />
        )}
      </AdminTile>

      <div className="grid gap-4 xl:grid-cols-2">
        <AdminTile title={p.sourcesTitle} description={p.sourcesDescription} data-testid="marketing-touch-sources">
          {sourceRows.length === 0 ? (
            <p className="text-sm text-zinc-500">{p.sourcesEmpty}</p>
          ) : (
            <AdminShareList
              rows={sourceRows.map((row) => ({
                key: `${row.source}/${row.medium}`,
                label: p.sourceRow(row.source, row.medium),
                value: row.count,
                valueLabel: number.format(row.count),
              }))}
            />
          )}
        </AdminTile>

        <AdminTile title={risk.funnel.title} description={risk.funnel.description}>
          <AdminFunnel
            steps={launchSteps}
            barHeight={110}
            rateLabel={(rate) => p.funnelRate(percent.format(rate))}
          />
        </AdminTile>
      </div>

      <AdminTile title={p.reviewTitle} description={p.reviewDescription}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Stat label={m.reviewStarted} value={number.format(review.startedUsers)} detail={m.uniqueActors} />
          <Stat
            label={m.reviewCompleted}
            value={reviewRate(review.completionRate)}
            detail={m.completedActors(review.completedUsers)}
          />
          <Stat
            label={m.upgradeIntent}
            value={reviewRate(review.upgradeIntentRate)}
            detail={m.afterReview(review.upgradeIntentUsers)}
          />
          <Stat label={m.checkout} value={reviewRate(review.checkoutRate)} detail={m.afterReview(review.checkoutUsers)} />
          <Stat label={m.purchase} value={reviewRate(review.purchaseRate)} detail={m.afterReview(review.purchaseUsers)} />
        </div>
      </AdminTile>

      <Disclosure summary={m.topCampaigns}>
        {dashboard.topCampaigns30d.length ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {dashboard.topCampaigns30d.map((campaign) => (
              <li
                key={`${campaign.source}:${campaign.medium}:${campaign.campaign}`}
                className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3"
              >
                <div className="flex justify-between gap-3 text-xs">
                  <span className="font-bold text-zinc-200">{campaign.campaign}</span>
                  <span className="font-black text-white">{campaign.landingViews}</span>
                </div>
                <p className="mt-1 truncate text-xs text-zinc-500">
                  {campaign.source} / {campaign.medium}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-500">{m.noLandingEvents}</p>
        )}
      </Disclosure>

      <Disclosure summary={m.touchTitle}>
        <div data-testid="marketing-touch-attribution">
          <p className="max-w-3xl text-sm leading-6 text-amber-200">{m.touchEvidence}</p>
          <p className="mt-1 text-xs leading-5 text-zinc-500">{m.touchWindow}</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            {([
              [m.touchSignups, touch.signups],
              [m.touchGuestLeads, touch.guestLeads],
            ] as const).flatMap(([label, summary]) => [
              <Stat key={`${label}-a`} label={label} value={String(summary.attributed)} detail={m.touchAttributed} />,
              <Stat key={`${label}-u`} label={label} value={String(summary.unattributed)} detail={m.touchUnattributed} />,
              <Stat
                key={`${label}-o`}
                label={label}
                value={summary.unobserved === null ? "-" : String(summary.unobserved)}
                detail={
                  summary.unobserved === null ? `${m.touchUnobserved} · ${m.touchUnobservedUnknown}` : m.touchUnobserved
                }
              />,
            ])}
          </div>
          <p className="mt-5 text-xs font-bold text-zinc-300">{m.touchChannels}</p>
          {touch.signups.channels.length ? (
            <ul className="mt-3 space-y-2">
              {touch.signups.channels.map((channel) => (
                <li
                  key={`${channel.source}:${channel.medium}:${channel.campaign}:${channel.content ?? ""}`}
                  className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3"
                >
                  <div className="flex justify-between gap-3 text-xs">
                    <span className="font-bold text-zinc-200">{channel.campaign}</span>
                    <span className="font-black text-white">{channel.count}</span>
                  </div>
                  <p className="mt-1 truncate text-xs text-zinc-500">
                    {channel.source} / {channel.medium}
                    {channel.content ? ` / ${channel.content}` : ""}
                    {channel.held ? ` · ${m.touchHeld}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">{m.touchNoChannels}</p>
          )}
        </div>
      </Disclosure>

      <Disclosure summary={m.funnelTitle}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2">{m.stage}</th>
                <th className="px-3 py-2">{m.event}</th>
                <th className="px-3 py-2 text-right">{m.count}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {eventGroups.flatMap((group) =>
                group.events.map((eventName, index) => (
                  <tr key={eventName}>
                    <td className="px-3 py-2 text-zinc-400">{index === 0 ? m.groups[group.label] : ""}</td>
                    <td className="px-3 py-2 font-mono text-xs text-zinc-200">{eventName}</td>
                    <td className="px-3 py-2 text-right font-black text-white">{counts.get(eventName) || 0}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs leading-5 text-zinc-500">{m.derivationNote}</p>
      </Disclosure>

      <Disclosure summary={p.deliverySummary}>
        <h3 className="text-sm font-bold text-white">{m.ga4Delivery}</h3>
        {[
          { label: "GA4_MEASUREMENT_ID", ready: dashboard.configured.measurementId },
          { label: "GA4_API_SECRET", ready: dashboard.configured.apiSecret },
        ].map((item) => (
          <div
            key={item.label}
            className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs"
          >
            <span className="font-mono text-zinc-300">{item.label}</span>
            <span className={item.ready ? "text-emerald-300" : "text-amber-300"}>{item.ready ? m.configured : m.missing}</span>
          </div>
        ))}
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs">
          <span className="font-mono text-zinc-300">NEXT_PUBLIC_GA4_DEBUG_MODE</span>
          <span className={dashboard.configured.debugMode ? "text-blue-300" : "text-zinc-500"}>
            {dashboard.configured.debugMode ? m.enabled : m.disabled}
          </span>
        </div>
        <p className="mt-2 text-[11px] leading-5 text-zinc-500">{m.debugModeNote}</p>
        <div className="mt-4 overflow-x-auto rounded-2xl border border-zinc-800">
          <p className="border-b border-zinc-800 px-3 py-3 text-xs font-bold text-zinc-300">{m.keyEventPolicy}</p>
          <table className="w-full min-w-[30rem] text-left text-xs">
            <thead className="text-zinc-500">
              <tr>
                <th className="px-3 py-2">{m.event}</th>
                <th className="px-3 py-2">{m.purpose}</th>
                <th className="px-3 py-2 text-right">{m.keyEvent}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {ga4KeyEventPolicy.map((item) => (
                <tr key={item.event}>
                  <td className="px-3 py-2 font-mono text-zinc-200">{item.event}</td>
                  <td className="px-3 py-2 text-zinc-400">{m.purposes[item.purpose]}</td>
                  <td
                    className={`px-3 py-2 text-right font-black ${item.keyEvent === "primary" ? "text-emerald-300" : "text-zinc-400"}`}
                  >
                    {item.keyEvent === "primary" ? m.keyEventPrimary : m.keyEventNo}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs leading-5 text-amber-200">{m.googleAdsNote}</p>
      </Disclosure>
    </section>
  );
}
