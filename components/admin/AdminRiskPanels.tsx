"use client";

import Link from "next/link";
import { AlertTriangle, BookOpen, KeyRound, LifeBuoy, TrendingUp } from "lucide-react";

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

type Props = {
  promoRisks: PromoRiskRow[];
  slaRows: SlaRow[];
  funnel: FunnelMetrics;
};

const pct = (value: number, total: number) =>
  total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "0.0%";

const dateLabel = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().replace("T", " ").slice(0, 16);
};

export function AdminRiskPanels({ promoRisks, slaRows, funnel }: Props) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
        <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
          Revenue protection
        </p>
        <h2 className="mt-2 text-2xl font-black text-white">Promotion risk monitor</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-400">
          Watch shared-IP/payment-method signals, high discounts, and redemption
          limits. Identifiers are stored only as keyed hashes.
        </p>
        <div className="mt-5 grid gap-2">
          {promoRisks.length === 0 ? (
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-200">
              No promotion abuse indicators detected.
            </div>
          ) : (
            promoRisks.map((promo) => (
              <div key={promo.code} className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-black text-white">{promo.code}</div>
                  <span className="rounded-full border border-amber-500/30 px-2.5 py-1 text-xs font-black text-amber-100">
                    {promo.risk}
                  </span>
                </div>
                <p className="mt-1 text-xs text-amber-100/70">
                  Redeemed {promo.redeemedCount} / {promo.maxRedemptions ?? "unlimited"} / {promo.discountPercent}% off
                  {promo.abuseSignalCount > 0
                    ? ` / ${promo.abuseSignalCount} hashed abuse signal${promo.abuseSignalCount === 1 ? "" : "s"}`
                    : ""}
                </p>
                {promo.abuseSignalCount > 0 ? (
                  <p className="mt-1 text-xs text-amber-100/70">
                    Shared IP {promo.sharedIpSignalCount} / Shared payment method{" "}
                    {promo.sharedPaymentMethodSignalCount}
                  </p>
                ) : null}
              </div>
            ))
          )}
        </div>
      </section>

      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
        <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
          Support SLA
        </p>
        <h2 className="mt-2 text-2xl font-black text-white">Open support age</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-400">
          Prioritize support requests older than 24 hours before they become churn risk.
        </p>
        <div className="mt-5 grid gap-2">
          {slaRows.length === 0 ? (
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-200">
              No open support requests are outside the SLA window.
            </div>
          ) : (
            slaRows.map((row) => (
              <Link
                key={row.id}
                href="/admin?tab=feedback"
                className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 transition hover:bg-red-500/15"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="font-black text-white">{row.email || row.id}</div>
                  <span className="rounded-full border border-red-500/30 px-2.5 py-1 text-xs font-black text-red-100">
                    {row.ageHours}h
                  </span>
                </div>
                <p className="mt-1 text-xs text-red-100/70">
                  {row.type} / {row.status} / {dateLabel(row.createdAt)} UTC
                </p>
              </Link>
            ))
          )}
        </div>
      </section>

      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
        <div className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-blue-300">
          <TrendingUp className="h-4 w-4" />
          Funnel
        </div>
        <h2 className="mt-2 text-2xl font-black text-white">Launch conversion funnel</h2>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {[
            ["Accounts", funnel.totalUsers, "100%"],
            ["Used chat", funnel.usersWithConversations, pct(funnel.usersWithConversations, funnel.totalUsers)],
            ["Checkout started", funnel.checkoutStarted, pct(funnel.checkoutStarted, funnel.totalUsers)],
            ["Paid users", funnel.paidUsers, pct(funnel.paidUsers, funnel.totalUsers)],
          ].map(([label, value, rate]) => (
            <div key={label} className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500">{label}</p>
              <p className="mt-2 text-2xl font-black text-white">{value}</p>
              <p className="mt-1 text-xs text-zinc-500">{rate}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
        <div className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-blue-300">
          <BookOpen className="h-4 w-4" />
          Runbooks
        </div>
        <h2 className="mt-2 text-2xl font-black text-white">Operator playbooks</h2>
        <div className="mt-5 grid gap-2">
          {[
            ["Plan not updated after payment", "Open user detail, run Stripe resync, then verify webhook log."],
            ["Provider outage", "Create incident mode, add user-facing note, recommend fallback model."],
            ["File upload failure", "Check R2 CORS, attachment limits, and support trace ID."],
            ["OAuth login issue", "Check provider account link, callback URL, and account linking audit log."],
          ].map(([title, detail]) => (
            <div key={title} className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                <div>
                  <p className="font-black text-white">{title}</p>
                  <p className="mt-1 text-sm leading-6 text-zinc-400">{detail}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5 xl:col-span-2">
        <div className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-blue-300">
          <KeyRound className="h-4 w-4" />
          Admin permissions
        </div>
        <h2 className="mt-2 text-2xl font-black text-white">Role matrix</h2>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="text-xs uppercase tracking-[0.16em] text-zinc-500">
              <tr>
                <th className="px-3 py-2">Role</th>
                <th className="px-3 py-2">Users</th>
                <th className="px-3 py-2">Billing</th>
                <th className="px-3 py-2">Providers</th>
                <th className="px-3 py-2">Support</th>
                <th className="px-3 py-2">Destructive</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {[
                ["owner", "Full", "Full", "Full", "Full", "Allowed"],
                ["billing", "Read", "Write", "Read", "Read", "No"],
                ["ops", "Read", "Read", "Write", "Read", "No"],
                ["support", "Read", "No", "Read", "Write", "No"],
                ["readonly", "Read", "Read", "Read", "Read", "No"],
              ].map((row) => (
                <tr key={row[0]} className="border-t border-zinc-800">
                  {row.map((cell) => (
                    <td key={cell} className="px-3 py-3 font-bold">{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 flex items-center gap-2 text-xs text-zinc-500">
          <LifeBuoy className="h-3.5 w-3.5" />
          Roles are resolved from ADMIN_OWNER_EMAILS, ADMIN_BILLING_EMAILS, ADMIN_OPS_EMAILS, ADMIN_SUPPORT_EMAILS, and ADMIN_READONLY_EMAILS.
        </p>
      </section>
    </div>
  );
}
