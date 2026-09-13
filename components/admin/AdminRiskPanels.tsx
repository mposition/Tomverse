import Link from "next/link";
import { AlertTriangle, BookOpen, TrendingUp } from "lucide-react";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminRiskPanelsMessages } from "@/lib/adminMessages/riskPanels";

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

export async function PromotionRiskPanel({
  promoRisks,
}: {
  promoRisks: PromoRiskRow[];
}) {
  const m = (await getAdminMessages(adminRiskPanelsMessages)).promotionRisk;
  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
        {m.eyebrow}
      </p>
      <h2 className="mt-2 text-2xl font-black text-white">{m.title}</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-400">
        {m.description}
      </p>
      <div className="mt-5 grid gap-2">
        {promoRisks.length === 0 ? (
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-200">
            {m.empty}
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
                {m.redemptionSummary(
                  promo.redeemedCount,
                  promo.maxRedemptions,
                  promo.discountPercent,
                  promo.abuseSignalCount
                )}
              </p>
              {promo.sharedIpSignalCount > 0 ||
              promo.sharedPaymentMethodSignalCount > 0 ? (
                <p className="mt-1 text-xs text-amber-100/70">
                  {m.sharedSignals(
                    promo.sharedIpSignalCount,
                    promo.sharedPaymentMethodSignalCount
                  )}
                </p>
              ) : null}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export async function SupportAgePanel({ slaRows }: { slaRows: SlaRow[] }) {
  const m = (await getAdminMessages(adminRiskPanelsMessages)).supportAge;
  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
        {m.eyebrow}
      </p>
      <h2 className="mt-2 text-2xl font-black text-white">{m.title}</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-400">
        {m.description}
      </p>
      <div className="mt-5 grid gap-2">
        {slaRows.length === 0 ? (
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-200">
            {m.empty}
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
                  {m.hoursOpen(row.ageHours)}
                </span>
              </div>
              <p className="mt-1 text-xs text-red-100/70">
                {m.reported(row.type, row.status, dateLabel(row.createdAt))}
              </p>
            </Link>
          ))
        )}
      </div>
    </section>
  );
}

export async function LaunchFunnelPanel({ funnel }: { funnel: FunnelMetrics }) {
  const m = (await getAdminMessages(adminRiskPanelsMessages)).funnel;
  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
        <TrendingUp className="h-4 w-4" aria-hidden />
        {m.eyebrow}
      </div>
      <h2 className="mt-2 text-2xl font-black text-white">
        {m.title}
      </h2>
      <p className="mt-2 text-sm leading-6 text-zinc-400">
        {m.description}
      </p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(
          [
            [m.accounts, funnel.totalUsers, "100%"],
            [
              m.usedChat,
              funnel.usersWithConversations,
              pct(funnel.usersWithConversations, funnel.totalUsers),
            ],
            [
              m.checkoutStarted,
              funnel.checkoutStarted,
              pct(funnel.checkoutStarted, funnel.totalUsers),
            ],
            [m.paidUsers, funnel.paidUsers, pct(funnel.paidUsers, funnel.totalUsers)],
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

export async function OperatorPlaybooksPanel() {
  const m = (await getAdminMessages(adminRiskPanelsMessages)).playbooks;
  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
        <BookOpen className="h-4 w-4" aria-hidden />
        {m.eyebrow}
      </div>
      <h2 className="mt-2 text-2xl font-black text-white">{m.title}</h2>
      <div className="mt-5 grid gap-2 xl:grid-cols-2">
        {(
          [
            [m.planNotUpdated.title, m.planNotUpdated.detail],
            [m.providerOutage.title, m.providerOutage.detail],
            [m.fileUploadFailure.title, m.fileUploadFailure.detail],
            [m.oauthLogin.title, m.oauthLogin.detail],
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
