"use client";

import { useState } from "react";
import { Clipboard, FileText, Loader2 } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";

type ReportRow = {
  id: string;
  title: string;
  body: string;
  status: string;
  recipient: string | null;
  createdAt: string;
};

const dateLabel = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().replace("T", " ").slice(0, 16);
};

export function AdminReportsPanel() {
  const [busy, setBusy] = useState(false);
  const [reports, setReports] = useState<ReportRow[]>([]);

  const createReport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/admin/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Tomverse weekly operations report" }),
      });
      const data = (await response.json().catch(() => null)) as
        | { report?: ReportRow; error?: string }
        | null;
      if (!response.ok || !data?.report) {
        throw new Error(data?.error || "Could not create report.");
      }
      setReports((current) => [data.report!, ...current]);
      await navigator.clipboard.writeText(data.report.body).catch(() => undefined);
      dispatchAppToast("Operations report created and copied.", "success");
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Could not create report.",
        "error"
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
            Reports
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">Operations report</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            Generate a compact weekly status report for users, paid accounts, feedback, refunds, alerts, and Stripe webhooks.
          </p>
        </div>
        <button
          type="button"
          onClick={createReport}
          disabled={busy}
          className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-black text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
          Generate report
        </button>
      </div>
      <div className="mt-5 grid gap-2">
        {reports.map((report) => (
          <article key={report.id} className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h3 className="text-sm font-black text-white">{report.title}</h3>
                <p className="mt-1 text-xs text-zinc-500">
                  {dateLabel(report.createdAt)} UTC / {report.status}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(report.body);
                  dispatchAppToast("Report copied.", "success");
                }}
                className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-black text-zinc-200 transition hover:bg-zinc-800"
              >
                <Clipboard className="h-3.5 w-3.5" />
                Copy
              </button>
            </div>
            <pre className="mt-3 whitespace-pre-wrap rounded-xl bg-zinc-950 p-3 text-xs leading-5 text-zinc-300">
              {report.body}
            </pre>
          </article>
        ))}
      </div>
    </section>
  );
}
