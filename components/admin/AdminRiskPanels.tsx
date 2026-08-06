import Link from "next/link";
import { AlertTriangle, BookOpen, TrendingUp } from "lucide-react";

/**
 * Four independent operator panels that used to be rendered together.
 *
 * As one component they forced every page that wanted promotion risk to also
 * render the conversion funnel, the runbooks and a second copy of the
 * administrator list -- the last of which `AdminAccessPanel` already renders in
 * full on `/admin/admin-access`. Split into named exports, each page mounts the
 * one it is about, and the duplicated access table is gone rather than hidden.
 */

export type PromoRiskRow = {
  code: string;
  redeemedCount: number;
  maxRedemptions: number | null;
  discountPercent: number;
  abuseSignalCount: number;
  sharedIpSignalCount: number;
  sharedPaymentMethodSignalCount: number;
  risk: string;
};

export type SlaRow = {
  id: string;
  email: string | null;
  type: string;
  status: string;
  ageHours: number;
  createdAt: string;
};

export type FunnelMetrics = {
  totalUsers: number;
  usersWithConversations: number;
  usersWithPaidPlan: number;
  checkoutStarted: number;
  paidUsers: number;
};

const pct = (value: number, total: number) =>
  total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "0.0%";

const dateLabel = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().replace("T", " ").slice(0, 16);
};

export function PromotionRiskPanel({
  promoRisks,
}: {
  promoRisks: PromoRiskRow[];
}) {
  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
        Risk
      </p>
      <h2 className="mt-2 text-2xl font-black text-white">Promotion risk monitor</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-400">
        Codes that are close to exhaustion, discount unusually deeply, or carry
        hashed abuse signals from their redemptions.
      </p>
      <div className="mt-5 grid gap-2">
        {promoRisks.length === 0 ? (
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-200">
            No promotion is currently flagged.
          </div>
        ) : (
          promoRisks.map((promo) => (
            <div
              key={promo.code}
              className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-black text-white">{promo.code}</div>
                <span className="rounded-full border border-amber-500/30 px-2.5 py-1 text-xs font-bold text-amber-100">
                  {promo.risk}
                </span>
              </div>
              <p className="mt-1 text-xs text-amber-100/70">
                {promo.redeemedCount}
                {promo.maxRedemptions ? ` / ${promo.maxRedemptions}` : ""} redeemed ·{" "}
                {promo.discountPercent}% off
                {promo.abuseSignalCount > 0
                  ? ` / ${promo.abuseSignalCount} hashed abuse signal${
                      promo.abuseSignalCount === 1 ? "" : "s"
                    }`
                  : ""}
              </p>
              {promo.sharedIpSignalCount > 0 ||
              promo.sharedPaymentMethodSignalCount > 0 ? (
                <p className="mt-1 text-xs text-amber-100/70">
                  {promo.sharedIpSignalCount} shared IP ·{" "}
                  {promo.sharedPaymentMethodSignalCount} shared payment method
                </p>
              ) : null}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export function SupportAgePanel({ slaRows }: { slaRows: SlaRow[] }) {
  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
        Service level
      </p>
      <h2 className="mt-2 text-2xl font-black text-white">Open support age</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-400">
        Open feedback older than 24 hours, from the ten most recent reports.
      </p>
      <div className="mt-5 grid gap-2">
        {slaRows.length === 0 ? (
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-200">
            No open report has breached the 24-hour mark.
          </div>
        ) : (
          slaRows.map((row) => (
            <Link
              key={row.id}
              href="/admin/support?tab=feedback"
              className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 transition hover:bg-red-500/15"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-black text-white">{row.email || row.id}</div>
                <span className="rounded-full border border-red-500/30 px-2.5 py-1 text-xs font-bold text-red-100">
                  {row.ageHours}h open
                </span>
              </div>
              <p className="mt-1 text-xs text-red-100/70">
                {row.type} · {row.status} · reported {dateLabel(row.createdAt)} UTC
              </p>
            </Link>
          ))
        )}
      </div>
    </section>
  );
}

export function LaunchFunnelPanel({ funnel }: { funnel: FunnelMetrics }) {
  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
        <TrendingUp className="h-4 w-4" aria-hidden />
        Funnel
      </div>
      <h2 className="mt-2 text-2xl font-black text-white">
        Launch conversion funnel
      </h2>
      <p className="mt-2 text-sm leading-6 text-zinc-400">
        Account-level counts over the whole database, not a sampled window.
      </p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(
          [
            ["Accounts", funnel.totalUsers, "100%"],
            [
              "Used chat",
              funnel.usersWithConversations,
              pct(funnel.usersWithConversations, funnel.totalUsers),
            ],
            [
              "Checkout started",
              funnel.checkoutStarted,
              pct(funnel.checkoutStarted, funnel.totalUsers),
            ],
            ["Paid users", funnel.paidUsers, pct(funnel.paidUsers, funnel.totalUsers)],
          ] as const
        ).map(([label, value, rate]) => (
          <div
            key={label}
            className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4"
          >
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-400">
              {label}
            </p>
            <p className="mt-2 text-2xl font-black text-white">{value}</p>
            <p className="mt-1 text-xs text-zinc-400">{rate}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function OperatorPlaybooksPanel() {
  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
        <BookOpen className="h-4 w-4" aria-hidden />
        Runbooks
      </div>
      <h2 className="mt-2 text-2xl font-black text-white">Operator playbooks</h2>
      <div className="mt-5 grid gap-2 xl:grid-cols-2">
        {(
          [
            [
              "Plan not updated after payment",
              "Open user detail, run Stripe resync, then verify webhook log.",
            ],
            [
              "Provider outage",
              "Create incident mode, add user-facing note, recommend fallback model.",
            ],
            [
              "File upload failure",
              "Check R2 CORS, attachment limits, and support trace ID.",
            ],
            [
              "OAuth login issue",
              "Check provider account link, callback URL, and account linking audit log.",
            ],
          ] as const
        ).map(([title, detail]) => (
          <div
            key={title}
            className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-amber-300"
                aria-hidden
              />
              <div>
                <p className="font-black text-white">{title}</p>
                <p className="mt-1 text-sm leading-6 text-zinc-400">{detail}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
