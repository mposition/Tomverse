import { AlertTriangle, BarChart3, CheckCircle2, ShieldCheck } from "lucide-react";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminProductAnalyticsMessages } from "@/lib/adminMessages/productAnalytics";
import type { ProductAnalyticsDashboard } from "@/lib/productAnalyticsDashboard";

const eventGroups = [
  { label: "acquisition", events: ["landing_view", "cta_start_click", "pricing_view", "plan_selected"] },
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

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-500">{label}</p>
      <p className="mt-3 text-2xl font-black text-white">{value}</p>
      <p className="mt-1 text-xs leading-5 text-zinc-500">{detail}</p>
    </div>
  );
}

export async function AdminProductAnalyticsPanel({
  dashboard,
}: {
  dashboard: ProductAnalyticsDashboard;
}) {
  const m = await getAdminMessages(adminProductAnalyticsMessages);
  const counts = new Map(
    dashboard.funnel30d.map((item) => [item.eventName, item.count])
  );

  return (
    <section className="flex flex-col gap-4">
      <div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-blue-300">
              <BarChart3 className="h-5 w-5" />
              <span className="text-xs font-bold uppercase tracking-[0.18em]">{m.eyebrow}</span>
            </div>
            <h2 className="mt-3 text-2xl font-black text-white">{m.title}</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
              {m.description}
            </p>
          </div>
          <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold ${dashboard.available ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-amber-500/30 bg-amber-500/10 text-amber-300"}`}>
            {dashboard.available ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
            {dashboard.available ? m.ledgerReady : m.migrationRequired}
          </span>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label={m.northStar} value={String(dashboard.weeklyActiveComparisonUsers)} detail={m.northStarDetail} />
          <Metric label={m.activation24h} value={`${dashboard.activationRate30d.toFixed(1)}%`} detail={m.activationDetail(dashboard.activatedUsers30d, dashboard.signupUsers30d)} />
          <Metric label={m.day1Return} value={String(dashboard.returnDay1Users30d)} detail={m.returnDetail} />
          <Metric label={m.day7Return} value={String(dashboard.returnDay7Users30d)} detail={m.returnDetail} />
        </div>

        <div className="mt-4 rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 text-sm leading-6 text-blue-100">
          <strong>{m.activationDefinitionLabel}</strong>{m.activationDefinition}
        </div>
      </div>

      <div className="rounded-3xl border border-blue-500/20 bg-blue-500/5 p-6">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">{m.reviewEyebrow}</p>
          <h3 className="mt-2 text-xl font-black text-white">{m.reviewTitle}</h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            {m.reviewDescription}
          </p>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Metric label={m.reviewStarted} value={String(dashboard.reviewFunnel30d.startedUsers)} detail={m.uniqueActors} />
          <Metric label={m.reviewCompleted} value={`${dashboard.reviewFunnel30d.completionRate.toFixed(1)}%`} detail={m.completedActors(dashboard.reviewFunnel30d.completedUsers)} />
          <Metric label={m.upgradeIntent} value={`${dashboard.reviewFunnel30d.upgradeIntentRate.toFixed(1)}%`} detail={m.afterReview(dashboard.reviewFunnel30d.upgradeIntentUsers)} />
          <Metric label={m.checkout} value={`${dashboard.reviewFunnel30d.checkoutRate.toFixed(1)}%`} detail={m.afterReview(dashboard.reviewFunnel30d.checkoutUsers)} />
          <Metric label={m.purchase} value={`${dashboard.reviewFunnel30d.purchaseRate.toFixed(1)}%`} detail={m.afterReview(dashboard.reviewFunnel30d.purchaseUsers)} />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
        <div className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900/60">
          <div className="border-b border-zinc-800 px-5 py-4">
            <h3 className="font-black text-white">{m.funnelTitle}</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead className="bg-zinc-950/60 text-xs uppercase tracking-[0.14em] text-zinc-500">
                <tr><th className="px-5 py-3">{m.stage}</th><th className="px-5 py-3">{m.event}</th><th className="px-5 py-3 text-right">{m.count}</th></tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {eventGroups.flatMap((group) =>
                  group.events.map((eventName, index) => (
                    <tr key={eventName}>
                      <td className="px-5 py-3 text-zinc-400">{index === 0 ? m.groups[group.label] : ""}</td>
                      <td className="px-5 py-3 font-mono text-xs text-zinc-200">{eventName}</td>
                      <td className="px-5 py-3 text-right font-black text-white">{counts.get(eventName) || 0}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-5">
            <h3 className="font-black text-white">{m.ga4Delivery}</h3>
            {[{ label: "GA4_MEASUREMENT_ID", ready: dashboard.configured.measurementId }, { label: "GA4_API_SECRET", ready: dashboard.configured.apiSecret }].map((item) => (
              <div key={item.label} className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-xs">
                <span className="font-mono text-zinc-300">{item.label}</span>
                <span className={item.ready ? "text-emerald-300" : "text-amber-300"}>{item.ready ? m.configured : m.missing}</span>
              </div>
            ))}
            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-xs">
              <span className="font-mono text-zinc-300">NEXT_PUBLIC_GA4_DEBUG_MODE</span>
              <span className={dashboard.configured.debugMode ? "text-blue-300" : "text-zinc-500"}>
                {dashboard.configured.debugMode ? m.enabled : m.disabled}
              </span>
            </div>
            <p className="mt-2 text-[11px] leading-5 text-zinc-500">
              {m.debugModeNote}
            </p>
            <div className="mt-4 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/70">
              <div className="border-b border-zinc-800 px-3 py-3">
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-zinc-300">{m.keyEventPolicy}</p>
              </div>
              <div className="overflow-x-auto">
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
                        <td className={`px-3 py-2 text-right font-black ${item.keyEvent === "primary" ? "text-emerald-300" : "text-zinc-400"}`}>
                          {item.keyEvent === "primary" ? m.keyEventPrimary : m.keyEventNo}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <p className="mt-3 text-xs leading-5 text-amber-200">
              {m.googleAdsNote}
            </p>
          </div>

          <div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-5">
            <h3 className="font-black text-white">{m.topCampaigns}</h3>
            {dashboard.topCampaigns30d.length ? (
              <div className="mt-3 space-y-2">
                {dashboard.topCampaigns30d.map((campaign) => (
                  <div key={`${campaign.source}:${campaign.medium}:${campaign.campaign}`} className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                    <div className="flex justify-between gap-3 text-xs"><span className="font-bold text-zinc-200">{campaign.campaign}</span><span className="font-black text-white">{campaign.landingViews}</span></div>
                    <p className="mt-1 truncate text-xs text-zinc-500">{campaign.source} / {campaign.medium}</p>
                  </div>
                ))}
              </div>
            ) : <p className="mt-3 text-sm text-zinc-500">{m.noLandingEvents}</p>}
          </div>

          <div className="flex items-start gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-xs leading-5 text-emerald-100">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            {m.derivationNote}
          </div>
        </div>
      </div>
    </section>
  );
}
