"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle2,
  Clipboard,
  Mail,
  Loader2,
  MessageSquare,
  Search,
} from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";

export type FeedbackRow = {
  id: string;
  userId: string | null;
  email: string | null;
  type: string;
  status: string;
  message: string;
  traceId: string | null;
  modelId: string | null;
  plan: string | null;
  hasAttachments: boolean;
  attachmentCount: number;
  path: string | null;
  userAgent: string | null;
  createdAt: string;
};

type Props = {
  rows: FeedbackRow[];
};

const statuses = ["open", "reviewing", "resolved", "closed"] as const;

const statusClass = (status: string) => {
  if (status === "resolved") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  if (status === "reviewing") return "border-blue-500/30 bg-blue-500/10 text-blue-200";
  if (status === "closed") return "border-zinc-700 bg-zinc-950 text-zinc-400";
  return "border-amber-500/30 bg-amber-500/10 text-amber-200";
};

const dateLabel = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().replace("T", " ").slice(0, 16);
};

export function FeedbackInboxPanel({ rows }: Props) {
  const [items, setItems] = useState(rows);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | typeof statuses[number]>("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return items.filter((item) => {
      const statusMatches = statusFilter === "all" || item.status === statusFilter;
      if (!statusMatches) return false;
      if (!normalizedQuery) return true;
      return [
        item.email,
        item.type,
        item.status,
        item.message,
        item.traceId,
        item.modelId,
        item.plan,
        item.path,
        item.userAgent,
      ]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(normalizedQuery));
    });
  }, [items, query, statusFilter]);

  const openCount = items.filter((item) => item.status === "open").length;

  const updateStatus = async (id: string, status: typeof statuses[number]) => {
    if (busyId) return;
    setBusyId(id);
    try {
      const response = await fetch(`/api/admin/feedback/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = (await response.json().catch(() => null)) as {
        feedback?: FeedbackRow;
        error?: string;
      } | null;
      if (!response.ok || !data?.feedback) {
        throw new Error(data?.error || "Feedback update failed.");
      }
      setItems((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                ...data.feedback,
                createdAt: data.feedback?.createdAt || item.createdAt,
              }
            : item
        )
      );
      dispatchAppToast("Feedback status updated.", "success");
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Failed to update feedback.",
        "error"
      );
    } finally {
      setBusyId(null);
    }
  };

  const copyContext = async (feedback: FeedbackRow) => {
    const text = [
      "Tomverse Feedback Context",
      `ID: ${feedback.id}`,
      `Status: ${feedback.status}`,
      `Type: ${feedback.type}`,
      `Email: ${feedback.email || "guest"}`,
      `Trace ID: ${feedback.traceId || "-"}`,
      `Model: ${feedback.modelId || "-"}`,
      `Plan: ${feedback.plan || "-"}`,
      `Attachments: ${feedback.attachmentCount}`,
      `Path: ${feedback.path || "-"}`,
      `Created: ${dateLabel(feedback.createdAt)} UTC`,
      `User agent: ${feedback.userAgent || "-"}`,
      "",
      feedback.message,
    ].join("\n");

    try {
      await navigator.clipboard.writeText(text);
      dispatchAppToast("Feedback context copied.", "success");
    } catch {
      dispatchAppToast("Could not copy feedback context.", "error");
    }
  };

  const supportReplyHref = (feedback: FeedbackRow) => {
    if (!feedback.email) return null;
    const subject = encodeURIComponent(`Tomverse support: ${feedback.type} request`);
    const body = encodeURIComponent(
      [
        `Hi,`,
        "",
        "Thanks for contacting Tomverse support. We reviewed your report and wanted to follow up.",
        "",
        "---",
        `Trace ID: ${feedback.traceId || "-"}`,
        `Model: ${feedback.modelId || "-"}`,
        `Plan: ${feedback.plan || "-"}`,
        `Path: ${feedback.path || "-"}`,
      ].join("\n")
    );
    return `mailto:${feedback.email}?subject=${subject}&body=${body}`;
  };

  return (
    <section id="feedback" className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
            Feedback
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">Support inbox</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            Review user feedback, copy reproduction context, and move issues through
            support states without leaving the Admin console.
          </p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-black text-amber-200">
          <MessageSquare className="h-3.5 w-3.5" />
          {openCount} open
        </span>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_auto]">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search email, trace ID, model, path, message..."
            className="h-11 w-full rounded-xl border border-zinc-800 bg-zinc-950 pl-10 pr-3 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          {(["all", ...statuses] as const).map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setStatusFilter(status)}
              className={`rounded-xl border px-3 py-2 text-xs font-black capitalize transition ${
                statusFilter === status
                  ? "border-blue-500/40 bg-blue-500/20 text-blue-100"
                  : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white"
              }`}
            >
              {status}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 grid gap-3">
        {filteredItems.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 text-sm text-zinc-400">
            No feedback matches the current filter.
          </div>
        ) : (
          filteredItems.map((feedback) => {
            const busy = busyId === feedback.id;
            return (
              <article
                key={feedback.id}
                className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4"
              >
                <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-xs font-black text-blue-200">
                        {feedback.type}
                      </span>
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${statusClass(feedback.status)}`}>
                        {feedback.status}
                      </span>
                      <span className="text-xs text-zinc-500">
                        {dateLabel(feedback.createdAt)} UTC
                      </span>
                    </div>
                    <div className="mt-3 text-sm font-black text-white">
                      {feedback.email || "guest"}
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-200">
                      {feedback.message}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => copyContext(feedback)}
                      className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-bold text-zinc-200 transition hover:bg-zinc-800"
                    >
                      <Clipboard className="h-3.5 w-3.5" />
                      Copy context
                    </button>
                    {supportReplyHref(feedback) ? (
                      <a
                        href={supportReplyHref(feedback) || undefined}
                        className="inline-flex items-center justify-center gap-2 rounded-xl border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs font-bold text-blue-100 transition hover:bg-blue-500/20"
                      >
                        <Mail className="h-3.5 w-3.5" />
                        Reply
                      </a>
                    ) : null}
                    {statuses.map((status) => (
                      <button
                        key={status}
                        type="button"
                        disabled={busy || feedback.status === status}
                        onClick={() => updateStatus(feedback.id, status)}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-bold capitalize text-zinc-200 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busy && feedback.status !== status ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : feedback.status === status ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
                        ) : null}
                        {status}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mt-3 grid gap-2 rounded-xl border border-zinc-800 bg-zinc-950/70 p-3 text-xs text-zinc-500 md:grid-cols-2 xl:grid-cols-4">
                  <span className="truncate">Trace: {feedback.traceId || "-"}</span>
                  <span className="truncate">Model: {feedback.modelId || "-"}</span>
                  <span className="truncate">Plan: {feedback.plan || "-"}</span>
                  <span>Attachments: {feedback.attachmentCount}</span>
                  <span className="truncate">Path: {feedback.path || "-"}</span>
                  <span className="truncate xl:col-span-3">
                    UA: {feedback.userAgent || "-"}
                  </span>
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
