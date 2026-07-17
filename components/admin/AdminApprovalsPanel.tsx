"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";

export type AdminApprovalRow = {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  status: string;
  reason: string | null;
  requestedByEmail: string | null;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  expiresAt: string;
  consumedAt: string | null;
  canReview?: boolean;
  createdAt: string;
};

const dateLabel = (value: string | null) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().replace("T", " ").slice(0, 16);
};

const statusClass = (status: string) => {
  if (status === "approved") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  if (status === "consumed") return "border-blue-500/30 bg-blue-500/10 text-blue-200";
  if (status === "rejected") return "border-red-500/30 bg-red-500/10 text-red-200";
  if (status === "expired") return "border-zinc-700 bg-zinc-800 text-zinc-300";
  return "border-amber-500/30 bg-amber-500/10 text-amber-200";
};

export function AdminApprovalsPanel() {
  const [rows, setRows] = useState<AdminApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/approvals", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as
        | { approvals?: AdminApprovalRow[]; error?: string }
        | null;
      if (!response.ok || !data?.approvals) {
        throw new Error(data?.error || "Could not load approval queue.");
      }
      setRows(data.approvals);
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Could not load approval queue.",
        "error"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
    const refresh = () => void load();
    window.addEventListener("admin:refresh", refresh);
    return () => window.removeEventListener("admin:refresh", refresh);
  }, [load]);

  const review = async (approvalId: string, status: "approved" | "rejected") => {
    setBusyId(approvalId);
    try {
      const response = await fetch("/api/admin/approvals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId, status }),
      });
      const data = (await response.json().catch(() => null)) as
        | { approval?: AdminApprovalRow; error?: string }
        | null;
      if (!response.ok || !data?.approval) {
        throw new Error(data?.error || "Could not update approval.");
      }
      setRows((current) =>
        current.map((row) => (row.id === data.approval?.id ? data.approval : row))
      );
      dispatchAppToast(`Approval ${status}.`, "success");
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Could not update approval.",
        "error"
      );
    } finally {
      setBusyId(null);
    }
  };

  const pendingCount = rows.filter((row) => row.status === "pending").length;
  const visibleRows = [
    ...rows.filter((row) => row.status === "pending" || row.status === "approved"),
    ...rows.filter((row) => row.status !== "pending" && row.status !== "approved").slice(0, 8),
  ];

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
            Approval workflow
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">High-risk admin approvals</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            A second authorized administrator reviews each exact target and payload. After approval,
            the original requester must retry the same action before expiry; successful execution consumes it once.
          </p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-black text-amber-200">
          <ShieldCheck className="h-3.5 w-3.5" />
          {pendingCount} pending
        </span>
      </div>

      <div className="mt-5 grid gap-3">
        {loading ? (
          <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading approvals...
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 text-sm text-zinc-400">
            No approval requests yet.
          </div>
        ) : (
          visibleRows.map((row) => (
            <article key={row.id} className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${statusClass(row.status)}`}>
                      {row.status}
                    </span>
                    <span className="font-black text-white">{row.action}</span>
                    <span className="text-xs text-zinc-500">{dateLabel(row.createdAt)} UTC</span>
                  </div>
                  <p className="mt-2 text-sm text-zinc-300">{row.reason || "No reason provided."}</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    Target: {row.targetType} {row.targetId || ""} / Requested by {row.requestedByEmail || "admin"}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    Expires {dateLabel(row.expiresAt)} UTC
                    {row.consumedAt ? ` / Consumed ${dateLabel(row.consumedAt)} UTC` : ""}
                  </p>
                  {row.reviewedAt ? (
                    <p className="mt-1 text-xs text-zinc-500">
                      Reviewed {dateLabel(row.reviewedAt)} by {row.reviewedByEmail || "admin"}
                    </p>
                  ) : null}
                </div>
                {row.status === "pending" && row.canReview ? (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void review(row.id, "approved")}
                      disabled={busyId === row.id}
                      className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-black text-emerald-100 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {busyId === row.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => void review(row.id, "rejected")}
                      disabled={busyId === row.id}
                      className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-black text-red-100 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      Reject
                    </button>
                  </div>
                ) : row.status === "pending" ? (
                  <span className="rounded-xl border border-zinc-700 px-3 py-2 text-xs font-bold text-zinc-400">
                    Awaiting another authorized administrator
                  </span>
                ) : row.status === "approved" ? (
                  <span className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-200">
                    Approved · original requester must retry exact action
                  </span>
                ) : null}
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
