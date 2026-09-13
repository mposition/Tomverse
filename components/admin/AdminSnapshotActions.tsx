"use client";

import { useState } from "react";
import { Clipboard, Mail } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { dispatchAppToast } from "@/lib/appToast";
import { adminOverviewMessages } from "@/lib/adminMessages/overview";

/**
 * The two operator actions that used to live inside `AdminOperationsPanel`.
 *
 * Kept as their own client component so the Overview summary around them can be
 * a server component, and so the panel's third button -- a `window.location`
 * reload that duplicated the shell's own Refresh control -- could be dropped
 * without taking these with it.
 */
export function AdminSnapshotActions({ report }: { report: string }) {
  const { snapshotActions: m } = useAdminMessages(adminOverviewMessages);
  const [sending, setSending] = useState(false);

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
      dispatchAppToast(m.copied, "success");
    } catch {
      dispatchAppToast(m.copyFailed, "error");
    }
  };

  const sendTestEmail = async () => {
    if (sending) return;
    setSending(true);
    try {
      const response = await fetch("/api/admin/test-email", { method: "POST" });
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        id?: string | null;
      } | null;
      if (!response.ok) throw new Error(data?.error || m.sendFailed);
      dispatchAppToast(
        data?.id ? m.sentWithId(data.id) : m.sent,
        "success"
      );
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : m.sendFailed,
        "error"
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={copyReport}
        className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-blue-500"
      >
        <Clipboard className="h-4 w-4" aria-hidden />
        {m.copySnapshot}
      </button>
      <button
        type="button"
        onClick={sendTestEmail}
        disabled={sending}
        className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-bold text-emerald-100 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Mail className="h-4 w-4" aria-hidden />
        {sending ? m.sending : m.sendTestEmail}
      </button>
    </div>
  );
}
