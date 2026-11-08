"use client";

import { formatAestDateTime } from "@/lib/adminUiCore";
import { useState } from "react";
import { Clipboard, FileText, Loader2 } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { dispatchAppToast } from "@/lib/appToast";
import { adminReportsMessages } from "@/lib/adminMessages/reports";
import { adminFetch } from "@/lib/adminFetch";

type ReportRow = {
  id: string;
  title: string;
  body: string;
  status: string;
  recipient: string | null;
  createdAt: string;
};

const dateLabel = (value: string) => formatAestDateTime(value) ?? "-";

export function AdminReportsPanel() {
  const m = useAdminMessages(adminReportsMessages);
  const [busy, setBusy] = useState(false);
  const [reports, setReports] = useState<ReportRow[]>([]);

  const createReport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await adminFetch("/api/admin/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Tomverse weekly operations report" }),
      });
      const data = (await response.json().catch(() => null)) as
        | { report?: ReportRow; error?: string }
        | null;
      if (!response.ok || !data?.report) {
        throw new Error(data?.error || m.createFailed);
      }
      setReports((current) => [data.report!, ...current]);
      await navigator.clipboard.writeText(data.report.body).catch(() => undefined);
      dispatchAppToast(m.created, "success");
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : m.createFailed,
        "error"
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminTile
      data-testid="admin-reports"
      title={m.title}
      description={m.description}
      action={
        <AdminWriteButton onClick={createReport} disabled={busy}>
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <FileText className="h-4 w-4" aria-hidden />
          )}
          {m.generate}
        </AdminWriteButton>
      }
    >
      {reports.length === 0 ? (
        <AdminStateBlock kind="empty" title={m.empty.title} detail={m.empty.detail} />
      ) : (
        <ul className="flex flex-col gap-3">
          {reports.map((report) => (
            <li key={report.id} className="rounded-2xl border border-zinc-800 bg-zinc-950/40 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-white">{report.title}</h3>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                    {m.createdAt(dateLabel(report.createdAt))}
                    <AdminStatusChip tone="idle">{report.status}</AdminStatusChip>
                  </p>
                </div>
                <AdminWriteButton
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(report.body);
                    dispatchAppToast(m.copied, "success");
                  }}
                >
                  <Clipboard className="h-3.5 w-3.5" aria-hidden />
                  {m.copy}
                </AdminWriteButton>
              </div>
              <pre className="mt-3 whitespace-pre-wrap rounded-xl bg-zinc-950 p-3 text-xs leading-5 text-zinc-300">
                {report.body}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </AdminTile>
  );
}
