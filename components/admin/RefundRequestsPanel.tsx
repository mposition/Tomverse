"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, Download, Loader2, RotateCcw, XCircle } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import { describeAdminApiFailure } from "@/lib/adminApiOutcome";
import { describeRefundApproval } from "@/lib/adminRefundOutcomeCopy";
import { formatBillingMinor, normalizeBillingCurrency } from "@/lib/billingMarkets";
import { adminIntlLocale } from "@/lib/adminLocale";
import { adminRefundsMessages } from "@/lib/adminMessages/refunds";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";

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

type Props = {
  rows: RefundRequestRow[];
  /**
   * How many rows the server read. Named on screen so the status counters are
   * read as "of the rows shown" rather than as totals.
   */
  rowLimit?: number;
};

const statusClass = (status: string) => {
  if (status === "approved") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  if (status === "rejected") return "border-red-500/30 bg-red-500/10 text-red-300";
  return "border-amber-500/30 bg-amber-500/10 text-amber-300";
};

const dateLabel = (value: string | null) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().replace("T", " ").slice(0, 16);
};

const money = (amountMinor: number | null, currencyValue: string | null) => {
  const currency = normalizeBillingCurrency(currencyValue || "USD") || "USD";
  return typeof amountMinor === "number"
    ? formatBillingMinor(amountMinor, currency, "en")
    : "-";
};

const escapeCsv = (value: unknown) => {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
};

export function RefundRequestsPanel({ rows, rowLimit }: Props) {
  const m = useAdminMessages(adminRefundsMessages);
  const { locale: apiLocale } = useAdminLocale();
  const intlLocale = adminIntlLocale(apiLocale);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedStatus = searchParams.get("status");
  const initialStatus = ["all", "pending", "approved", "rejected"].includes(
    requestedStatus || ""
  )
    ? (requestedStatus as "all" | "pending" | "approved" | "rejected")
    : "pending";
  const [items, setItems] = useState(rows);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [creditReviewConfirmed, setCreditReviewConfirmed] = useState<Record<string, boolean>>({});
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "approved" | "rejected">(
    initialStatus
  );
  const visiblePendingCount = items.filter((item) => item.status === "pending").length;
  const approvedCount = items.filter((item) => item.status === "approved").length;
  const rejectedCount = items.filter((item) => item.status === "rejected").length;
  const filteredItems =
    statusFilter === "all"
      ? items
      : items.filter((item) => item.status === statusFilter);

  const selectStatus = (status: typeof statusFilter) => {
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
      const response = await fetch(`/api/admin/refund-requests/${id}`, {
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
        // A 409 with an approvalId is the two-person policy working, not a
        // failure -- reporting it as one makes the operator retry and queue a
        // second request.
        const failure = describeAdminApiFailure({
          status: response.status,
          error: data?.error,
          code: data?.code,
          approvalId: data?.approvalId,
          fallback: m.toasts.notUpdated,
          locale: apiLocale,
        });
        dispatchAppToast(failure.message, failure.tone);
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

  return (
    <section id="refunds" className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
            {m.eyebrow}
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">
            {m.title}
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            {m.description}
            {rowLimit ? m.rowLimit(rowLimit) : ""}
          </p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-bold text-amber-200">
          <RotateCcw className="h-3.5 w-3.5" />
          {m.pendingBadge(visiblePendingCount)}
        </span>
        <button
          type="button"
          onClick={exportCsv}
          className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-bold text-zinc-200 transition hover:bg-zinc-900"
        >
          <Download className="h-3.5 w-3.5" />
          {m.exportCsv}
        </button>
      </div>

      <div className="mt-5 grid gap-3">
        <div className="flex flex-wrap gap-2">
          {[
            ["pending", m.filters.pending(visiblePendingCount)],
            ["approved", m.filters.approved(approvedCount)],
            ["rejected", m.filters.rejected(rejectedCount)],
            ["all", m.filters.all(items.length)],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => selectStatus(value as typeof statusFilter)}
              className={`cursor-pointer rounded-xl border px-3 py-2 text-xs font-black transition ${
                statusFilter === value
                  ? "border-blue-500/40 bg-blue-500/20 text-blue-100"
                  : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-200/80">{m.counters.pending}</p>
            <p className="mt-1 text-2xl font-black text-white">{visiblePendingCount}</p>
          </div>
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-200/80">{m.counters.approved}</p>
            <p className="mt-1 text-2xl font-black text-white">{approvedCount}</p>
          </div>
          <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-200/80">{m.counters.rejected}</p>
            <p className="mt-1 text-2xl font-black text-white">{rejectedCount}</p>
          </div>
        </div>

        {filteredItems.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 text-sm text-zinc-400">
            {m.empty}
          </div>
        ) : (
          filteredItems.map((request) => {
            const pending = request.status === "pending";
            const busy = busyId === request.id;
            return (
              <article key={request.id} className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${statusClass(request.status)}`}>
                        {request.status}
                      </span>
                      <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-xs font-bold text-blue-200">
                        {request.plan || m.unknownPlan}
                      </span>
                      <span className="text-xs text-zinc-500">
                        {m.requested(dateLabel(request.requestedAt))}
                      </span>
                    </div>
                    <h3 className="mt-3 truncate text-base font-bold text-white">
                      {request.email || m.noEmail}
                    </h3>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-300">
                      {request.reason || m.noReason}
                    </p>
                  </div>
                  <div className="grid gap-2 text-xs text-zinc-500 lg:min-w-[280px]">
                    <span>{m.details.stripeCustomer(request.stripeCustomerId || "-")}</span>
                    <span>{m.details.subscription(request.stripeSubscriptionId || "-")}</span>
                    <span>{m.details.status(request.subscriptionStatus || "-")}</span>
                    <span>{m.details.billing(request.subscriptionBillingInterval || "-")}</span>
                    <span>{m.details.periodEnd(dateLabel(request.subscriptionCurrentPeriodEnd))}</span>
                    <span>{m.details.stripeRefund(request.stripeRefundId || "-")}</span>
                    <span>{m.details.refundStatus(request.stripeRefundStatus || "-")}</span>
                    <span>{m.details.refundAmount(money(request.refundAmountCents, request.refundCurrency))}</span>
                    <span>{m.details.reviewed(dateLabel(request.reviewedAt))}</span>
                  </div>
                </div>

                {request.adminNote && (
                  <p className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs leading-5 text-zinc-400">
                    {m.adminNote(request.adminNote)}
                  </p>
                )}

                {request.creditRisk?.requiresReview ? (
                  <div className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-4">
                    <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-200">
                      {m.creditRisk.title}
                    </p>
                    <div className="mt-3 grid gap-2 text-xs text-red-100 sm:grid-cols-2 lg:grid-cols-4">
                      <span>{m.creditRisk.purchases(request.creditRisk.purchaseCount)}</span>
                      <span>{m.creditRisk.remaining(request.creditRisk.remainingCredits.toLocaleString(intlLocale), (request.creditRisk.remainingCostMicroUsd / 1_000_000).toFixed(2))}</span>
                      <span>{m.creditRisk.estimatedConsumed(request.creditRisk.estimatedUsedCredits.toLocaleString(intlLocale), (request.creditRisk.estimatedConsumedCostMicroUsd / 1_000_000).toFixed(2))}</span>
                      <span className="font-black">{m.creditRisk.unrecovered(request.creditRisk.unrecoveredCredits.toLocaleString(intlLocale), (request.creditRisk.unrecoveredCostMicroUsd / 1_000_000).toFixed(2))}</span>
                    </div>
                    <p className="mt-2 text-xs text-red-200/80">
                      {m.creditRisk.billingRisk(request.creditRisk.billingRiskStatus)}
                    </p>
                    {request.status === "pending" ? (
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

                {request.timelineEvents && request.timelineEvents.length > 0 ? (
                  <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-950/70 p-3">
                    <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-500">
                      {m.timeline}
                    </p>
                    <div className="mt-3 grid gap-2">
                      {request.timelineEvents.map((event) => (
                        <div key={event.id} className="flex gap-3 text-xs">
                          <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-blue-400" />
                          <div>
                            <p className="font-black text-zinc-200">{event.eventType}</p>
                            <p className="mt-0.5 text-zinc-400">{event.message}</p>
                            <p className="mt-0.5 text-zinc-600">
                              {m.timelineMeta(dateLabel(event.createdAt), event.actorEmail)}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {pending && (
                  <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto]">
                    <input
                      value={notes[request.id] || ""}
                      onChange={(event) =>
                        setNotes((current) => ({
                          ...current,
                          [request.id]: event.target.value,
                        }))
                      }
                      placeholder={m.notePlaceholder}
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={
                          Boolean(busyId) ||
                          Boolean(
                            request.creditRisk?.requiresReview &&
                              !creditReviewConfirmed[request.id]
                          )
                        }
                        onClick={() => updateRequest(request.id, "approve")}
                        className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                        {m.approve}
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(busyId)}
                        onClick={() => updateRequest(request.id, "reject")}
                        className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-500/30 px-4 py-2.5 text-sm font-bold text-red-200 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <XCircle className="h-4 w-4" />
                        {m.reject}
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
