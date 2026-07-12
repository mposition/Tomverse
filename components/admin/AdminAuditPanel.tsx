"use client";

import { useMemo, useState } from "react";
import { Clipboard, Eye, Loader2, Search, ShieldCheck, X } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";

export type AdminAuditRow = {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  metadata?: unknown;
};

type Props = {
  rows: AdminAuditRow[];
};

const dateTimeLabel = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().replace("T", " ").slice(0, 16);
};

const actionTone = (action: string) => {
  if (action.includes("delete") || action.includes("refund.approve")) {
    return "border-red-500/30 bg-red-500/10 text-red-200";
  }
  if (action.includes("billing") || action.includes("refund")) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-200";
  }
  return "border-blue-500/30 bg-blue-500/10 text-blue-200";
};

export function AdminAuditPanel({ rows }: Props) {
  const [query, setQuery] = useState("");
  const [targetFilter, setTargetFilter] = useState("all");
  const [detail, setDetail] = useState<AdminAuditRow | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);

  const targets = useMemo(
    () => ["all", ...Array.from(new Set(rows.map((row) => row.targetType))).sort()],
    [rows]
  );

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (targetFilter !== "all" && row.targetType !== targetFilter) return false;
      if (!normalizedQuery) return true;
      return [
        row.actorEmail,
        row.actorUserId,
        row.action,
        row.targetType,
        row.targetId,
        row.summary,
        row.ipAddress,
        row.userAgent,
      ]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(normalizedQuery));
    });
  }, [query, rows, targetFilter]);

  const highRiskCount = rows.filter(
    (row) => row.action.includes("delete") || row.action.includes("refund.approve")
  ).length;
  const uniqueActors = new Set(rows.map((row) => row.actorEmail || row.actorUserId).filter(Boolean)).size;

  const copyAudit = async (row: AdminAuditRow) => {
    const text = [
      "Tomverse Admin Audit Event",
      `Time: ${dateTimeLabel(row.createdAt)} UTC`,
      `Actor: ${row.actorEmail || row.actorUserId || "Unknown admin"}`,
      `Action: ${row.action}`,
      `Target: ${row.targetType} ${row.targetId || ""}`.trim(),
      `IP: ${row.ipAddress || "-"}`,
      `User agent: ${row.userAgent || "-"}`,
      "",
      row.summary,
    ].join("\n");

    try {
      await navigator.clipboard.writeText(text);
      dispatchAppToast("Audit event copied.", "success");
    } catch {
      dispatchAppToast("Could not copy audit event.", "error");
    }
  };

  const loadDetail = async (row: AdminAuditRow) => {
    setLoadingDetailId(row.id);
    try {
      const response = await fetch(`/api/admin/audit/${row.id}`);
      const data = (await response.json().catch(() => null)) as {
        audit?: AdminAuditRow;
        error?: string;
      } | null;
      if (!response.ok || !data?.audit) {
        throw new Error(data?.error || "Could not load audit detail.");
      }
      setDetail(data.audit);
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Could not load audit detail.",
        "error"
      );
    } finally {
      setLoadingDetailId(null);
    }
  };

  const exportCsv = () => {
    const escapeCsv = (value: string | null) =>
      `"${(value || "").replaceAll('"', '""').replaceAll("\n", " ")}"`;
    const csv = [
      ["time", "actor", "action", "targetType", "targetId", "summary", "ipAddress"].join(","),
      ...filteredRows.map((row) =>
        [
          dateTimeLabel(row.createdAt),
          row.actorEmail || row.actorUserId || "",
          row.action,
          row.targetType,
          row.targetId || "",
          row.summary,
          row.ipAddress || "",
        ]
          .map(escapeCsv)
          .join(",")
      ),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `tomverse-admin-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
            Audit
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">Admin activity log</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            Search sensitive operational actions, copy incident context, and review
            billing or user-impacting changes from the console.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 px-4 py-3">
            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-zinc-500">
              Events
            </p>
            <p className="mt-1 text-xl font-black text-white">{rows.length}</p>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 px-4 py-3">
            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-zinc-500">
              Actors
            </p>
            <p className="mt-1 text-xl font-black text-white">{uniqueActors}</p>
          </div>
          <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3">
            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-red-200/80">
              High risk
            </p>
            <p className="mt-1 text-xl font-black text-red-100">{highRiskCount}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-bold text-zinc-200 transition hover:bg-zinc-800 xl:self-start"
        >
          <Clipboard className="h-3.5 w-3.5" />
          Export CSV
        </button>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_15rem]">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search actor, action, target, summary, IP..."
            className="h-11 w-full rounded-xl border border-zinc-800 bg-zinc-950 pl-10 pr-3 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
          />
        </label>
        <select
          value={targetFilter}
          onChange={(event) => setTargetFilter(event.target.value)}
          className="h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm font-bold text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
        >
          {targets.map((target) => (
            <option key={target} value={target}>
              {target === "all" ? "All targets" : target}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[980px] border-separate border-spacing-y-2 text-left text-sm">
          <thead className="text-xs uppercase tracking-[0.16em] text-zinc-500">
            <tr>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Actor</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Target</th>
              <th className="px-3 py-2">Summary</th>
              <th className="px-3 py-2">Context</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((log) => (
              <tr key={log.id} className="bg-zinc-900/70 text-zinc-200">
                <td className="rounded-l-2xl px-3 py-3 text-xs text-zinc-400">
                  {dateTimeLabel(log.createdAt)}
                </td>
                <td className="px-3 py-3">
                  <div className="font-bold">{log.actorEmail || "Unknown admin"}</div>
                  <div className="mt-1 max-w-[12rem] truncate text-xs text-zinc-500">
                    {log.actorUserId || "-"}
                  </div>
                </td>
                <td className="px-3 py-3">
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${actionTone(log.action)}`}>
                    {log.action}
                  </span>
                </td>
                <td className="px-3 py-3 text-xs text-zinc-400">
                  <div className="font-bold text-zinc-300">{log.targetType}</div>
                  <div className="mt-1 max-w-[12rem] truncate">{log.targetId || "-"}</div>
                </td>
                <td className="px-3 py-3 text-sm text-zinc-300">{log.summary}</td>
                <td className="rounded-r-2xl px-3 py-3">
                  <button
                    type="button"
                    onClick={() => copyAudit(log)}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-bold text-zinc-200 transition hover:bg-zinc-800"
                  >
                    <Clipboard className="h-3.5 w-3.5" />
                    Copy
                  </button>
                  <button
                    type="button"
                    onClick={() => loadDetail(log)}
                    disabled={loadingDetailId === log.id}
                    className="ml-2 inline-flex cursor-pointer items-center gap-2 rounded-xl border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs font-bold text-blue-100 transition hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {loadingDetailId === log.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                    Details
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredRows.length === 0 ? (
          <div className="mt-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 text-sm text-zinc-400">
            No audit events match the current filters.
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-2xl border border-blue-500/20 bg-blue-500/10 p-4 text-sm leading-6 text-blue-100">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        Keep this log reviewed after billing, refund, or user deletion changes. It is
        intended for operational investigation, not customer-facing disclosure.
      </div>

      {detail ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="max-h-[86vh] w-full max-w-3xl overflow-y-auto rounded-3xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl shadow-black">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
                  Audit detail
                </p>
                <h3 className="mt-2 text-xl font-black text-white">{detail.action}</h3>
                <p className="mt-1 text-sm text-zinc-500">
                  {dateTimeLabel(detail.createdAt)} UTC / {detail.actorEmail || "Unknown admin"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDetail(null)}
                className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border border-zinc-700 text-zinc-400 transition hover:bg-zinc-900 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
                <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500">Target</p>
                <p className="mt-2 text-sm font-black text-white">{detail.targetType}</p>
                <p className="mt-1 break-all text-xs text-zinc-400">{detail.targetId || "-"}</p>
              </div>
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
                <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500">Request</p>
                <p className="mt-2 break-all text-xs text-zinc-400">IP: {detail.ipAddress || "-"}</p>
                <p className="mt-1 break-all text-xs text-zinc-400">UA: {detail.userAgent || "-"}</p>
              </div>
            </div>
            <div className="mt-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500">Summary</p>
              <p className="mt-2 text-sm leading-6 text-zinc-200">{detail.summary}</p>
            </div>
            <div className="mt-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500">Metadata</p>
              <pre className="mt-3 max-h-96 overflow-auto rounded-xl bg-zinc-950 p-3 text-xs leading-5 text-zinc-300">
                {JSON.stringify(detail.metadata || {}, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
