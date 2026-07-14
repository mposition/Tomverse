import { AlertTriangle, BarChart3, CheckCircle2, ShieldCheck } from "lucide-react";
import type { ProductAnalyticsDashboard } from "@/lib/productAnalyticsDashboard";

const eventGroups = [
  { label: "Acquisition", events: ["landing_view", "cta_start_click", "pricing_view", "plan_selected"] },
  { label: "Onboarding", events: ["onboarding_shown", "onboarding_completed", "onboarding_skipped"] },
  { label: "First experience", events: ["chat_started", "first_response_completed"] },
  { label: "Core value", events: ["multi_model_compare_completed"] },
  { label: "Activation action", events: ["followup_sent", "file_attached", "conversation_saved", "share_created"] },
  { label: "Upgrade intent", events: ["credit_limit_hit", "upgrade_prompt_view"] },
  { label: "Signup", events: ["signup_page_view", "signup_started", "signup_completed"] },
  { label: "Payment", events: ["checkout_started", "checkout_failed", "purchase_completed"] },
  { label: "Retention", events: ["return_day_1", "return_day_7", "subscription_cancelled"] },
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

export function AdminProductAnalyticsPanel({
  dashboard,
}: {
  dashboard: ProductAnalyticsDashboard;
}) {
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
              <span className="text-xs font-black uppercase tracking-[0.18em]">Product analytics</span>
            </div>
            <h2 className="mt-3 text-2xl font-black text-white">Go-live funnel and activation</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
              First-party, consented events provide operational truth while GA4 supplies campaign analysis. Prompts, responses, filenames, file contents, email, and profile data are excluded.
            </p>
          </div>
          <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black ${dashboard.available ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-amber-500/30 bg-amber-500/10 text-amber-300"}`}>
            {dashboard.available ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
            {dashboard.available ? "Ledger ready" : "Migration required"}
          </span>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="North Star" value={String(dashboard.weeklyActiveComparisonUsers)} detail="Weekly active comparison users" />
          <Metric label="24h activation" value={`${dashboard.activationRate30d.toFixed(1)}%`} detail={`${dashboard.activatedUsers30d} of ${dashboard.signupUsers30d} new users (30d)`} />
          <Metric label="Day 1 return" value={String(dashboard.returnDay1Users30d)} detail="Unique returning users recorded in 30d" />
          <Metric label="Day 7 return" value={String(dashboard.returnDay7Users30d)} detail="Unique returning users recorded in 30d" />
        </div>

        <div className="mt-4 rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 text-sm leading-6 text-blue-100">
          <strong>Activation definition:</strong> a new user completes a comparison with at least two models within 24 hours of signup and then sends a follow-up, saves a conversation, or creates a share.
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
        <div className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900/60">
          <div className="border-b border-zinc-800 px-5 py-4">
            <h3 className="font-black text-white">Event funnel · last 30 days</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead className="bg-zinc-950/60 text-xs uppercase tracking-[0.14em] text-zinc-500">
                <tr><th className="px-5 py-3">Stage</th><th className="px-5 py-3">Event</th><th className="px-5 py-3 text-right">Count</th></tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {eventGroups.flatMap((group) =>
                  group.events.map((eventName, index) => (
                    <tr key={eventName}>
                      <td className="px-5 py-3 text-zinc-400">{index === 0 ? group.label : ""}</td>
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
            <h3 className="font-black text-white">GA4 delivery</h3>
            {[{ label: "GA4_MEASUREMENT_ID", ready: dashboard.configured.measurementId }, { label: "GA4_API_SECRET", ready: dashboard.configured.apiSecret }].map((item) => (
              <div key={item.label} className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-xs">
                <span className="font-mono text-zinc-300">{item.label}</span>
                <span className={item.ready ? "text-emerald-300" : "text-amber-300"}>{item.ready ? "Configured" : "Missing"}</span>
              </div>
            ))}
          </div>

          <div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-5">
            <h3 className="font-black text-white">Top acquisition campaigns · 30d</h3>
            {dashboard.topCampaigns30d.length ? (
              <div className="mt-3 space-y-2">
                {dashboard.topCampaigns30d.map((campaign) => (
                  <div key={`${campaign.source}:${campaign.medium}:${campaign.campaign}`} className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                    <div className="flex justify-between gap-3 text-xs"><span className="font-bold text-zinc-200">{campaign.campaign}</span><span className="font-black text-white">{campaign.landingViews}</span></div>
                    <p className="mt-1 truncate text-xs text-zinc-500">{campaign.source} / {campaign.medium}</p>
                  </div>
                ))}
              </div>
            ) : <p className="mt-3 text-sm text-zinc-500">No consented landing events yet.</p>}
          </div>

          <div className="flex items-start gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-xs leading-5 text-emerald-100">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            Country is derived from trusted edge headers when available; plan is resolved from the database for signed-in users.
          </div>
        </div>
      </div>
    </section>
  );
}
