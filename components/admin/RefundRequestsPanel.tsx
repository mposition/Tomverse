"use client";

import { useState } from "react";
import { CheckCircle2, Download, Loader2, RotateCcw, XCircle } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";

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
  requestedAt: string;
  reviewedAt: string | null;
  timelineEvents?: Array<{
    id: string;
    eventType: string;
    message: string;
    actorEmail: string | null;
    createdAt: string;
  }>;
};

type Props = {
  rows: RefundRequestRow[];
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

const money = (cents: number | null) =>
  typeof cents === "number" ? `$${(cents / 100).toFixed(2)}` : "-";

const escapeCsv = (value: unknown) => {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
};

export function RefundRequestsPanel({ rows }: Props) {
  const [items, setItems] = useState(rows);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "approved" | "rejected">("pending");
  const visiblePendingCount = items.filter((item) => item.status === "pending").length;
  const approvedCount = items.filter((item) => item.status === "approved").length;
  const rejectedCount = items.filter((item) => item.status === "rejected").length;
  const filteredItems =
    statusFilter === "all"
      ? items
      : items.filter((item) => item.status === statusFilter);
  const pendingLabel = visiblePendingCount === 1 ? "pending" : "pending";

  const exportCsv = () => {
    const csv = [
      ["id", "requestedAt", "email", "plan", "status", "subscriptionStatus", "billingInterval", "periodEnd", "stripeCustomerId", "refundAmountCents", "reason"],
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
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        refundRequest?: RefundRequestRow;
        error?: string;
      } | null;
      if (!response.ok || !data?.refundRequest) {
        throw new Error(data?.error || "Refund update failed");
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
      dispatchAppToast(
        action === "approve"
          ? "Refund request approved. The user was moved to Free."
          : "Refund request rejected.",
        "success"
      );
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Failed to update refund request.",
        "error"
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section id="refunds" className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
            Refunds
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">
            Cancellation and refund requests
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            Review customer refund requests, cancel Stripe subscriptions, reset paid
            membership to Free, and send transactional email updates.
          </p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-black text-amber-200">
          <RotateCcw className="h-3.5 w-3.5" />
          {visiblePendingCount} {pendingLabel}
        </span>
        <button
          type="button"
          onClick={exportCsv}
          className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-black text-zinc-200 transition hover:bg-zinc-900"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </button>
      </div>

      <div className="mt-5 grid gap-3">
        <div className="flex flex-wrap gap-2">
          {[
            ["pending", `Pending ${visiblePendingCount}`],
            ["approved", `Approved ${approvedCount}`],
            ["rejected", `Rejected ${rejectedCount}`],
            ["all", `All ${items.length}`],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setStatusFilter(value as typeof statusFilter)}
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
            <p className="text-xs font-black uppercase tracking-[0.16em] text-amber-200/80">Pending</p>
            <p className="mt-1 text-2xl font-black text-white">{visiblePendingCount}</p>
          </div>
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-emerald-200/80">Approved</p>
            <p className="mt-1 text-2xl font-black text-white">{approvedCount}</p>
          </div>
          <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-red-200/80">Rejected</p>
            <p className="mt-1 text-2xl font-black text-white">{rejectedCount}</p>
          </div>
        </div>

        {filteredItems.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 text-sm text-zinc-400">
            No refund requests match the current filter.
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
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${statusClass(request.status)}`}>
                        {request.status}
                      </span>
                      <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-xs font-black text-blue-200">
                        {request.plan || "Unknown plan"}
                      </span>
                      <span className="text-xs text-zinc-500">
                        Requested {dateLabel(request.requestedAt)}
                      </span>
                    </div>
                    <h3 className="mt-3 truncate text-base font-black text-white">
                      {request.email || "No email"}
                    </h3>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-300">
                      {request.reason || "No reason provided."}
                    </p>
                  </div>
                  <div className="grid gap-2 text-xs text-zinc-500 lg:min-w-[280px]">
                    <span>Stripe customer: {request.stripeCustomerId || "-"}</span>
                    <span>Subscription: {request.stripeSubscriptionId || "-"}</span>
                    <span>Status: {request.subscriptionStatus || "-"}</span>
                    <span>Billing: {request.subscriptionBillingInterval || "-"}</span>
                    <span>Period end: {dateLabel(request.subscriptionCurrentPeriodEnd)}</span>
                    <span>Stripe refund: {request.stripeRefundId || "-"}</span>
                    <span>Refund status: {request.stripeRefundStatus || "-"}</span>
                    <span>Refund amount: {money(request.refundAmountCents)}</span>
                    <span>Reviewed: {dateLabel(request.reviewedAt)}</span>
                  </div>
                </div>

                {request.adminNote && (
                  <p className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs leading-5 text-zinc-400">
                    Admin note: {request.adminNote}
                  </p>
                )}

                {request.timelineEvents && request.timelineEvents.length > 0 ? (
                  <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-950/70 p-3">
                    <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
                      Timeline
                    </p>
                    <div className="mt-3 grid gap-2">
                      {request.timelineEvents.map((event) => (
                        <div key={event.id} className="flex gap-3 text-xs">
                          <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-blue-400" />
                          <div>
                            <p className="font-black text-zinc-200">{event.eventType}</p>
                            <p className="mt-0.5 text-zinc-400">{event.message}</p>
                            <p className="mt-0.5 text-zinc-600">
                              {dateLabel(event.createdAt)} UTC / {event.actorEmail || "system"}
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
                      placeholder="Optional note for the customer email"
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={Boolean(busyId)}
                        onClick={() => updateRequest(request.id, "approve")}
                        className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-black text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(busyId)}
                        onClick={() => updateRequest(request.id, "reject")}
                        className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-500/30 px-4 py-2.5 text-sm font-black text-red-200 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <XCircle className="h-4 w-4" />
                        Reject
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
