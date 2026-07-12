"use client";

import { useMemo, useState } from "react";
import { Bell, Download } from "lucide-react";

export type AdminNotificationRow = {
  id: string;
  channel: string;
  title: string;
  detail: string | null;
  status: string;
  targetType: string | null;
  targetId: string | null;
  error: string | null;
  createdAt: string;
};

type Props = {
  rows: AdminNotificationRow[];
};

const dateLabel = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().replace("T", " ").slice(0, 16);
};

const statusClass = (status: string) => {
  if (status === "sent") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  if (status === "skipped") return "border-zinc-700 bg-zinc-900 text-zinc-400";
  return "border-red-500/30 bg-red-500/10 text-red-200";
};

const escapeCsv = (value: unknown) => {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
};

export function AdminNotificationsPanel({ rows }: Props) {
  const [statusFilter, setStatusFilter] = useState("all");
  const filteredRows = useMemo(
    () => rows.filter((row) => statusFilter === "all" || row.status === statusFilter),
    [rows, statusFilter]
  );
  const failedCount = rows.filter((row) => row.status === "failed").length;
  const sentCount = rows.filter((row) => row.status === "sent").length;

  const exportCsv = () => {
    const csv = [
      ["createdAt", "channel", "status", "title", "targetType", "targetId", "error"],
      ...filteredRows.map((row) => [
        row.createdAt,
        row.channel,
        row.status,
        row.title,
        row.targetType || "",
        row.targetId || "",
        row.error || "",
      ]),
    ]
      .map((line) => line.map(escapeCsv).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "tomverse-admin-notifications.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
            Alerts
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">Notification delivery log</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            Track Slack, Discord, and email alert delivery for provider budgets and incidents.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-black text-emerald-200">
            <Bell className="h-3.5 w-3.5" />
            {sentCount} sent
          </span>
          <span className="rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-xs font-black text-red-200">
            {failedCount} failed
          </span>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {["all", "sent", "failed", "skipped"].map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setStatusFilter(status)}
              className={`cursor-pointer rounded-xl border px-3 py-2 text-xs font-black capitalize transition ${
                statusFilter === status
                  ? "border-blue-500/40 bg-blue-500/20 text-blue-100"
                  : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white"
              }`}
            >
              {status}
            </button>
          ))}
        </div>
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
        {filteredRows.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 text-sm text-zinc-400">
            No notification logs match this filter.
          </div>
        ) : (
          filteredRows.map((row) => (
            <article key={row.id} className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${statusClass(row.status)}`}>
                      {row.status}
                    </span>
                    <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-xs font-black uppercase text-blue-200">
                      {row.channel}
                    </span>
                    <span className="text-xs text-zinc-500">{dateLabel(row.createdAt)} UTC</span>
                  </div>
                  <h3 className="mt-3 text-sm font-black text-white">{row.title}</h3>
                  {row.detail ? <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-300">{row.detail}</p> : null}
                </div>
                <div className="grid gap-1 text-xs text-zinc-500 md:min-w-64">
                  <span>Target: {row.targetType || "-"} {row.targetId || ""}</span>
                  <span>Error: {row.error || "-"}</span>
                </div>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
