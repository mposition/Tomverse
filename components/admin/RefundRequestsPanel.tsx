"use client";

import { formatAestDateTime, type AdminTone } from "@/lib/adminUiCore";
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Download, Loader2 } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import {
  describeAdminApiFailure,
  type AdminApiFailure,
} from "@/lib/adminApiOutcome";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { AdminBars } from "@/components/admin/ui/AdminCharts";
import { AdminConfirmDialog } from "@/components/admin/ui/AdminConfirmDialog";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { describeRefundApproval } from "@/lib/adminRefundOutcomeCopy";
import {
  approvedRefundMonths,
  creditUseShare,
  waitingDays,
} from "@/lib/adminRefundStats";
import { formatBillingMinor, normalizeBillingCurrency } from "@/lib/billingMarkets";
import { adminIntlLocale } from "@/lib/adminLocale";
import { adminRefundsMessages } from "@/lib/adminMessages/refunds";
import { adminUiMessages } from "@/lib/adminMessages/ui";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";

export type RefundRequestRow = {
  id: string;
  email: string | null;
  plan: string | null;
  status: string;
  reason: string | null;
  adminNote: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
  subscriptionBillingInterval: string | null;
  subscriptionCurrentPeriodEnd: string | null;
  stripeRefundId: string | null;
  stripeRefundStatus: string | null;
  stripeChargeId: string | null;
  refundAmountCents: number | null;
  refundCurrency: string | null;
  requestedAt: string;
  reviewedAt: string | null;
  timelineEvents?: Array<{
    id: string;
    eventType: string;
    message: string;
    actorEmail: string | null;
    createdAt: string;
  }>;
  creditRisk?: {
    requiresReview: boolean;
    purchaseCount: number;
    purchasedCredits: number;
    remainingCredits: number;
    estimatedUsedCredits: number;
    purchasedCostMicroUsd: number;
    remainingCostMicroUsd: number;
    estimatedConsumedCostMicroUsd: number;
    unrecoveredCredits: number;
    unrecoveredCostMicroUsd: number;
    billingRiskStatus: string;
  };
};

type StatusFilter = "all" | "pending" | "approved" | "rejected";

type Props = {
  rows: RefundRequestRow[];
  /**
   * How many rows the server read. Named on screen so the status counters are
   * read as "of the rows shown" rather than as totals.
   */
  rowLimit?: number;
  /**
   * When the server rendered the page. The waiting-days chip and the "this
   * month" figures are measured from it; without it they are left out rather
   * than guessed from the browser clock (which would differ between the server
   * and the client render).
   */
  generatedAt?: string;
  /** False when the signed-in role cannot decide refunds; the buttons lock. */
  writable?: boolean;
};

const STATUS_TONE: Record<string, AdminTone> = {
  pending: "warn",
  processing: "info",
  approved: "ok",
  rejected: "bad",
};

const dateLabel = (value: string | null) => formatAestDateTime(value) ?? "-";

const money = (amountMinor: number | null, currencyValue: string | null) => {
  const currency = normalizeBillingCurrency(currencyValue || "USD") || "USD";
  return typeof amountMinor === "number"
    ? formatBillingMinor(amountMinor, currency, "en")
    : null;
};

const escapeCsv = (value: unknown) => {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
};

const initialsOf = (email: string | null) =>
  (email || "").replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?";

/** One labelled figure in a request card; an unread figure says so. */
function Stat({
  label,
  children,
  detail,
}: {
  label: string;
  /** `null` when the figure cannot be stated. */
  children: React.ReactNode | null;
  detail?: React.ReactNode;
}) {
  const ui = useAdminMessages(adminUiMessages);
  const unread = children === null;
  return (
    <div className="min-w-0">
      <p className="text-xs text-zinc-500">{label}</p>
      <div
        data-unread={unread ? "true" : undefined}
        className={`mt-1 font-bold tabular-nums ${unread ? "text-base text-zinc-400" : "text-2xl text-white"}`}
      >
        {unread ? ui.unavailable : children}
      </div>
      {detail ? <p className="mt-1 text-xs text-zinc-500">{detail}</p> : null}
    </div>
  );
}

export function RefundRequestsPanel({ rows, rowLimit, generatedAt, writable = true }: Props) {
  const m = useAdminMessages(adminRefundsMessages);
  const { locale: apiLocale } = useAdminLocale();
  const intlLocale = adminIntlLocale(apiLocale);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedStatus = searchParams.get("status");
  const initialStatus: StatusFilter = ["all", "pending", "approved", "rejected"].includes(
    requestedStatus || ""
  )
    ? (requestedStatus as StatusFilter)
    : "pending";
  // The toast fades; a step-up refusal needs something that does not. The
  // operator has to leave this screen to renew their sign-in, and a sentence
  // that named the remedy and then disappeared is the defect rule 7 is about.
  const [apiFailure, setApiFailure] = useState<AdminApiFailure | null>(null);
  const [items, setItems] = useState(rows);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [creditReviewConfirmed, setCreditReviewConfirmed] = useState<Record<string, boolean>>({});
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialStatus);
  const visiblePendingCount = items.filter((item) => item.status === "pending").length;
  const approvedCount = items.filter((item) => item.status === "approved").length;
  const rejectedCount = items.filter((item) => item.status === "rejected").length;
  const filteredItems =
    statusFilter === "all"
      ? items
      : items.filter((item) => item.status === statusFilter);
  const confirming = items.find((item) => item.id === confirmId) ?? null;
  const months = approvedRefundMonths(items, generatedAt);

  const selectStatus = (status: StatusFilter) => {
    setStatusFilter(status);
    const params = new URLSearchParams(searchParams.toString());
    if (status === "pending") params.delete("status");
    else params.set("status", status);
    const suffix = params.toString();
    router.replace(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false });
  };

  const exportCsv = () => {
    const csv = [
      ["id", "requestedAt", "email", "plan", "status", "subscriptionStatus", "billingInterval", "periodEnd", "stripeCustomerId", "refundAmountMinor", "refundCurrency", "reason"],
      ...filteredItems.map((request) => [
        request.id,
        request.requestedAt,
        request.email || "",
        request.plan || "",
        request.status,
        request.subscriptionStatus || "",
        request.subscriptionBillingInterval || "",
        request.subscriptionCurrentPeriodEnd || "",
        request.stripeCustomerId || "",
        request.refundAmountCents ?? "",
        request.refundCurrency || "",
        request.reason || "",
      ]),
    ]
      .map((line) => line.map(escapeCsv).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "tomverse-admin-refunds.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const updateRequest = async (id: string, action: "approve" | "reject") => {
    if (busyId) return;
    setBusyId(id);
    try {
      const response = await adminFetch(`/api/admin/refund-requests/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          adminNote: notes[id] || undefined,
          confirmCreditReview:
            action === "approve" ? Boolean(creditReviewConfirmed[id]) : undefined,
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        refundRequest?: RefundRequestRow;
        error?: string;
        code?: string;
        approvalId?: string;
      } | null;
      if (!response.ok || !data?.refundRequest) {
        // A leftover approval id is a refusal. The action was not applied.
        const failure = describeAdminApiFailure({
          status: response.status,
          error: data?.error,
          code: data?.code,
          approvalId: data?.approvalId,
          fallback: m.toasts.notUpdated,
          locale: apiLocale,
        });
        dispatchAppToast(failure.message, failure.tone);
        setApiFailure(failure);
        return;
      }
      setItems((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                ...data.refundRequest,
                requestedAt:
                  data.refundRequest?.requestedAt || item.requestedAt,
              }
            : item
        )
      );
      if (action === "approve") {
        // Whether money actually moved depends on what Stripe had; the row
        // above now carries the same status this sentence reports.
        const outcome = describeRefundApproval(data.refundRequest);
        dispatchAppToast(outcome.message, outcome.tone);
      } else {
        dispatchAppToast(m.toasts.rejected, "success");
      }
    } catch {
      dispatchAppToast(m.toasts.connectionFailed, "error");
    } finally {
      setBusyId(null);
    }
  };

  const monthLabel = (key: string) => {
    const [year, month] = key.split("-").map(Number);
    // Mid-month, local time: the month is the same whichever zone formats it.
    return new Intl.DateTimeFormat(intlLocale, { month: "short" }).format(
      new Date(year, month - 1, 15)
    );
  };

  const filterTabs: Array<[StatusFilter, string]> = [
    ["pending", m.filters.pending(visiblePendingCount)],
    ["approved", m.filters.approved(approvedCount)],
    ["rejected", m.filters.rejected(rejectedCount)],
    ["all", m.filters.all(items.length)],
  ];

  return (
    <section id="refunds" className="flex min-w-0 flex-col gap-5">
      {apiFailure ? <AdminApiFailureNotice failure={apiFailure} /> : null}
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-zinc-800">
        <div role="group" aria-label={m.filtersLabel} className="flex flex-wrap gap-1">
          {filterTabs.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={statusFilter === value}
              onClick={() => selectStatus(value)}
              className={`-mb-px cursor-pointer border-b-2 px-3 py-2.5 text-sm font-bold transition ${
                statusFilter === value
                  ? "border-blue-500 text-white"
                  : "border-transparent text-zinc-400 hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={exportCsv}
          className="mb-2 inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-100 transition hover:bg-zinc-800"
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          {m.exportCsv}
        </button>
      </div>
      {rowLimit ? <p className="-mt-2 text-xs text-zinc-500">{m.rowLimit(rowLimit)}</p> : null}

      <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          {filteredItems.length === 0 ? (
            <AdminStateBlock kind="empty" title={m.empty.title} detail={m.empty.detail} />
          ) : (
            filteredItems.map((request) => {
              const pending = request.status === "pending";
              const busy = busyId === request.id;
              const risk = request.creditRisk;
              const needsReview = Boolean(risk?.requiresReview);
              const share = creditUseShare(risk);
              const days = pending ? waitingDays(request.requestedAt, generatedAt) : null;
              const refunded = money(request.refundAmountCents, request.refundCurrency);
              const interval =
                request.subscriptionBillingInterval === "monthly" || request.subscriptionBillingInterval === "yearly"
                  ? m.interval[request.subscriptionBillingInterval]
                  : request.subscriptionBillingInterval;
              const statusWord =
                request.status in m.status
                  ? m.status[request.status as keyof typeof m.status]
                  : request.status;
              const timeline = request.timelineEvents ?? [];
              return (
                <AdminTile key={request.id} as="article" className="gap-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        aria-hidden
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-500/15 text-sm font-bold text-blue-300"
                      >
                        {initialsOf(request.email)}
                      </span>
                      <div className="min-w-0">
                        <h3 className="truncate text-base font-bold text-white">
                          {request.email || m.noEmail}
                        </h3>
                        <p className="truncate text-xs text-zinc-500">
                          {[request.plan || m.unknownPlan, interval].filter(Boolean).join(" · ")}
                          {" · "}
                          {m.requested(dateLabel(request.requestedAt))}
                        </p>
                      </div>
                    </div>
                    {pending ? (
                      days === null ? (
                        <AdminStatusChip tone="warn">{statusWord}</AdminStatusChip>
                      ) : (
                        <AdminStatusChip tone={days >= 3 ? "warn" : "info"}>
                          {m.waiting(days)}
                        </AdminStatusChip>
                      )
                    ) : (
                      <AdminStatusChip tone={STATUS_TONE[request.status] ?? "idle"}>
                        {statusWord}
                      </AdminStatusChip>
                    )}
                  </div>

                  <div className="grid gap-4 rounded-2xl bg-zinc-950/60 p-4 sm:grid-cols-3">
                    <Stat
                      label={pending ? m.stats.amountPending : m.stats.amountDone}
                      detail={pending ? m.stats.amountPendingDetail : undefined}
                    >
                      {pending ? null : refunded}
                    </Stat>
                    <Stat label={m.stats.creditsUsed}>
                      {share === null ? null : share.kind === "none" ? (
                        <span className="text-base text-zinc-300">{m.stats.noPurchases}</span>
                      ) : (
                        <div>
                          <div className="flex items-center gap-2">
                            <span
                              role="img"
                              aria-label={`${share.percent}%`}
                              className="h-2 min-w-16 flex-1 overflow-hidden rounded-full bg-zinc-800"
                            >
                              <span
                                className="block h-full rounded-full bg-blue-500"
                                style={{ width: `${share.percent}%` }}
                              />
                            </span>
                            <span className="text-base">{share.percent}%</span>
                          </div>
                          <p className="mt-1 text-xs font-normal text-zinc-500">
                            {m.stats.creditsUsedDetail(
                              share.used.toLocaleString(intlLocale),
                              share.purchased.toLocaleString(intlLocale)
                            )}
                          </p>
                        </div>
                      )}
                    </Stat>
                    <Stat
                      label={m.stats.creditsLeft}
                      detail={
                        risk
                          ? m.stats.creditsLeftDetail((risk.remainingCostMicroUsd / 1_000_000).toFixed(2))
                          : undefined
                      }
                    >
                      {risk ? risk.remainingCredits.toLocaleString(intlLocale) : null}
                    </Stat>
                  </div>

                  <blockquote className="border-l-2 border-blue-500/50 pl-4 text-sm leading-6 text-zinc-200">
                    {request.reason ? (
                      <span className="whitespace-pre-wrap">&ldquo;{request.reason}&rdquo;</span>
                    ) : (
                      <span className="text-zinc-500">{m.noReason}</span>
                    )}
                  </blockquote>

                  {request.adminNote ? (
                    <p className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs leading-5 text-zinc-400">
                      {m.adminNote(request.adminNote)}
                    </p>
                  ) : null}

                  {!pending ? (
                    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
                      <span>{m.refundStatus(request.stripeRefundStatus || "-")}</span>
                      <span>{m.reviewed(dateLabel(request.reviewedAt))}</span>
                    </p>
                  ) : null}

                  {risk?.requiresReview ? (
                    <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4">
                      <p className="text-sm font-bold text-red-200">{m.creditRisk.title}</p>
                      <div className="mt-3 grid gap-2 text-xs text-red-100 sm:grid-cols-2">
                        <span>{m.creditRisk.purchases(risk.purchaseCount)}</span>
                        <span>{m.creditRisk.remaining(risk.remainingCredits.toLocaleString(intlLocale), (risk.remainingCostMicroUsd / 1_000_000).toFixed(2))}</span>
                        <span>{m.creditRisk.estimatedConsumed(risk.estimatedUsedCredits.toLocaleString(intlLocale), (risk.estimatedConsumedCostMicroUsd / 1_000_000).toFixed(2))}</span>
                        <span className="font-bold">{m.creditRisk.unrecovered(risk.unrecoveredCredits.toLocaleString(intlLocale), (risk.unrecoveredCostMicroUsd / 1_000_000).toFixed(2))}</span>
                      </div>
                      <p className="mt-2 text-xs text-red-200/80">
                        {m.creditRisk.billingRisk(risk.billingRiskStatus)}
                      </p>
                      {pending ? (
                        <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs font-bold text-white">
                          <input
                            type="checkbox"
                            checked={Boolean(creditReviewConfirmed[request.id])}
                            onChange={(event) =>
                              setCreditReviewConfirmed((current) => ({
                                ...current,
                                [request.id]: event.target.checked,
                              }))
                            }
                            className="mt-0.5 h-4 w-4"
                          />
                          {m.creditRisk.confirm}
                        </label>
                      ) : null}
                    </div>
                  ) : null}

                  <div>
                    <p className="text-xs font-bold text-zinc-500">{m.timeline}</p>
                    <ol className="mt-2 flex flex-col">
                      <li className="flex gap-3 border-t border-zinc-800 py-2 text-sm first:border-t-0">
                        <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
                        <div className="min-w-0">
                          <p className="font-bold text-zinc-100">{m.requestedEvent}</p>
                          <p className="text-xs text-zinc-500">{dateLabel(request.requestedAt)}</p>
                        </div>
                      </li>
                      {timeline.map((event) => (
                        <li key={event.id} className="flex gap-3 border-t border-zinc-800 py-2 text-sm">
                          <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
                          <div className="min-w-0">
                            <p className="font-bold text-zinc-100">{event.message}</p>
                            <p className="text-xs text-zinc-500">
                              {m.timelineMeta(dateLabel(event.createdAt), event.actorEmail)}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </div>

                  <AdminTechInfo summary={m.technical.summary}>
                    <ul className="flex flex-col gap-1 break-all">
                      <li>{m.technical.requestId(request.id)}</li>
                      <li>{m.technical.stripeCustomer(request.stripeCustomerId || "-")}</li>
                      <li>{m.technical.subscription(request.stripeSubscriptionId || "-")}</li>
                      <li>{m.technical.subscriptionStatus(request.subscriptionStatus || "-")}</li>
                      <li>{m.technical.periodEnd(dateLabel(request.subscriptionCurrentPeriodEnd))}</li>
                      <li>{m.technical.stripeRefund(request.stripeRefundId || "-")}</li>
                      <li>{m.technical.stripeCharge(request.stripeChargeId || "-")}</li>
                    </ul>
                  </AdminTechInfo>

                  {pending ? (
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                      <input
                        value={notes[request.id] || ""}
                        onChange={(event) =>
                          setNotes((current) => ({
                            ...current,
                            [request.id]: event.target.value,
                          }))
                        }
                        placeholder={m.notePlaceholder}
                        className="min-h-10 w-full flex-1 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
                      />
                      <div className="flex flex-wrap gap-2 lg:justify-end">
                        <AdminWriteButton
                          variant="secondary"
                          writable={writable}
                          requiredRole="billing"
                          disabled={Boolean(busyId)}
                          onClick={() => updateRequest(request.id, "reject")}
                        >
                          {m.reject}
                        </AdminWriteButton>
                        <AdminWriteButton
                          stepUp
                          writable={writable}
                          requiredRole="billing"
                          disabled={Boolean(busyId) || (needsReview && !creditReviewConfirmed[request.id])}
                          onClick={() => setConfirmId(request.id)}
                        >
                          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                          {m.approve}
                        </AdminWriteButton>
                      </div>
                    </div>
                  ) : null}
                </AdminTile>
              );
            })
          )}
        </div>

        {months ? (
          <aside className="flex min-w-0 flex-col gap-4" aria-label={m.aside.thisMonth}>
            <AdminTile title={m.aside.thisMonth}>
              <p className="text-3xl font-bold tabular-nums tracking-tight text-white">
                {months.thisMonth.count === 0
                  ? m.aside.thisMonthNone
                  : [
                      m.aside.thisMonthCount(months.thisMonth.count),
                      ...months.thisMonth.amounts.map(
                        (amount) => money(amount.minor, amount.currency) ?? ""
                      ),
                    ]
                      .filter(Boolean)
                      .join(", ")}
              </p>
              {months.thisMonth.withoutAmount > 0 ? (
                <p className="text-xs text-amber-300">
                  {m.aside.unknownAmounts(months.thisMonth.withoutAmount)}
                </p>
              ) : null}
              <p className="text-xs text-zinc-500">{m.aside.thisMonthBasis(items.length)}</p>
              {months.hasData ? (
                <div className="mt-2 border-t border-zinc-800 pt-3">
                  <p className="text-sm font-bold text-white">{m.aside.monthlyTitle}</p>
                  <AdminBars
                    values={months.counts}
                    width={280}
                    height={72}
                    gap={6}
                    highlight={months.counts.length - 1}
                    label={m.aside.monthlyLabel(months.counts.length)}
                    className="mt-3 h-[72px] w-full"
                  />
                  <div className="mt-1 flex justify-between text-xs text-zinc-500">
                    <span>{monthLabel(months.keys[0])}</span>
                    <span className="font-bold text-zinc-300">
                      {monthLabel(months.keys[months.keys.length - 1])}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-zinc-500">{m.aside.monthlyBasis(items.length)}</p>
                </div>
              ) : null}
            </AdminTile>
          </aside>
        ) : null}
      </div>

      <AdminConfirmDialog
        open={Boolean(confirming)}
        title={m.confirmApprove.title}
        stepUp
        confirmLabel={m.approve}
        busy={Boolean(confirming && busyId === confirming.id)}
        summary={
          confirming ? (
            <div className="flex flex-col gap-1">
              <p className="font-bold text-white">
                {m.confirmApprove.customer(confirming.email || m.noEmail)}
              </p>
              <p>{m.confirmApprove.amount}</p>
              {confirming.creditRisk ? (
                <p>
                  {m.confirmApprove.creditsLeft(
                    confirming.creditRisk.remainingCredits.toLocaleString(intlLocale)
                  )}
                </p>
              ) : null}
            </div>
          ) : null
        }
        effects={[
          m.confirmApprove.effects.refund,
          m.confirmApprove.effects.cancel,
          m.confirmApprove.effects.free,
          m.confirmApprove.effects.email,
          m.confirmApprove.effects.second,
        ]}
        onConfirm={async () => {
          if (!confirming) return;
          await updateRequest(confirming.id, "approve");
          setConfirmId(null);
        }}
        onClose={() => setConfirmId(null)}
      />
    </section>
  );
}
