"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  BellRing,
  CheckCircle2,
  Clipboard,
  Download,
  Mail,
  Loader2,
  MessageSquare,
  Search,
  X,
} from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import { AdminNotesBox } from "@/components/admin/AdminNotesBox";
import {
  FEEDBACK_CLOSURE_OUTCOMES,
  FEEDBACK_USER_REPLY_MAX_LENGTH,
  FEEDBACK_USER_REPLY_MIN_LENGTH,
  feedbackUserReplyState,
  isTerminalFeedbackStatus,
  type FeedbackClosureOutcome,
} from "@/lib/feedbackLifecycleCore";
import { buildFeedbackLifecycleEmail } from "@/lib/feedbackLifecycleEmails";
import { feedbackReferenceFromId } from "@/lib/feedbackPolicy";

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
  language: string;
  emailUpdatesConsent: boolean;
  closureOutcome: string | null;
  userReply: string | null;
  /** Token verification outcome -- lib/errorReportContract.ts vocabulary.
   * Null for reports that predate the feature or carry no trace. */
  errorReportVerification: string | null;
  traceProvenance: string | null;
  errorClassificationSource: string | null;
  clientErrorCode: string | null;
  evidenceAvailability: string | null;
  /** Phase 2 diagnosis-only shadow case, when one was queued. Observational:
   * no auto-fix pipeline exists, and the panel says so in words. */
  autoFixCase: {
    state: string;
    classification: string | null;
    ineligibilityReason: string | null;
    updatedAt: string;
  } | null;
  /** The exactly-linked evidence occurrence, when verification made one. */
  traceEvidence: {
    occurrenceId: string;
    environment: string;
    release: string | null;
    routeClass: string;
    phase: string | null;
    errorCode: string | null;
    classificationSource: string;
    httpStatus: number | null;
    provider: string | null;
    modelId: string | null;
    sentryEventId: string | null;
    occurredAt: string;
  } | null;
  createdAt: string;
};

/**
 * Operator-facing sentence for each verification state. Words, not colour:
 * verified/unverified must never be a hue-only distinction, and a
 * client-classified report must never read as a server-authenticated fact.
 */
const traceVerificationLabel = (feedback: FeedbackRow) => {
  switch (feedback.errorReportVerification) {
    case "verified":
      return "Verified server error (signed token)";
    case "missing_token":
      return feedback.clientErrorCode === "EMPTY_RESPONSE"
        ? "Client-classified EMPTY_RESPONSE — server token not issued"
        : "Unverified — no server token";
    case "expired":
      return "Unverified — token expired";
    case "invalid_signature":
      return "Unverified — invalid token signature";
    case "payload_mismatch":
      return "Unverified — token does not match this trace";
    case "unsupported_version":
      return "Unverified — unsupported token version";
    case "untrusted_trace_source":
      return "Unverified — client-supplied trace";
    default:
      return feedback.traceId ? "Unverified — manual trace" : null;
  }
};

const evidenceAvailabilityLabel = (value: string | null) => {
  switch (value) {
    case "recorded":
      return "Evidence recorded";
    case "intentionally_not_recorded":
      return "No evidence row by policy";
    case "existing_limit_event":
      return "See existing limit-decision events for this trace";
    case "existing_provider_event":
      return "See existing provider events for this trace";
    case "not_yet_available":
      return "Evidence row not found (write pending, capped or failed)";
    case "ambiguous_trace":
      return "Multiple occurrences share this trace — no exact link";
    default:
      return null;
  }
};

type Props = {
  rows: FeedbackRow[];
};

/** The server's account of what happened to the submitter email, verbatim. */
type UserNotificationResult =
  | { queued: true; delivered: boolean }
  | { queued: false; reason: "no_stage" | "already_notified" | "not_notifiable" };

const statuses = ["open", "reviewing", "resolved", "closed"] as const;

/** Whether lifecycle emails can reach this reporter at all. */
const isNotifiable = (feedback: FeedbackRow) =>
  Boolean(feedback.email) && feedback.emailUpdatesConsent;

/**
 * The sentence the toast adds about the submitter email. A failed send is
 * "queued for retry" -- never a failed status change, which by this point has
 * already committed.
 */
const userNotificationSentence = (result: UserNotificationResult | undefined) => {
  if (!result) return "";
  if (result.queued) {
    return result.delivered
      ? " The reporter was emailed."
      : " Reporter email queued; delivery will be retried.";
  }
  if (result.reason === "already_notified") {
    return " This stage was already announced -- no new email.";
  }
  return "";
};

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

const escapeCsv = (value: unknown) => {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
};

export function FeedbackInboxPanel({ rows }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedStatus = searchParams.get("status");
  const initialStatus =
    requestedStatus && statuses.includes(requestedStatus as (typeof statuses)[number])
      ? (requestedStatus as (typeof statuses)[number])
      : "all";
  const [items, setItems] = useState(rows);
  const [query, setQuery] = useState(() => searchParams.get("q") || "");
  const [statusFilter, setStatusFilter] = useState<"all" | typeof statuses[number]>(
    initialStatus
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  /**
   * Closing is never one click: resolved/closed go through a small dialog
   * that collects the outcome code and the user-facing reply, and previews
   * the email the reporter will receive.
   */
  const [closeTarget, setCloseTarget] = useState<{
    feedback: FeedbackRow;
    status: "resolved" | "closed";
  } | null>(null);

  const updateLocation = (nextQuery: string, nextStatus: typeof statusFilter) => {
    const params = new URLSearchParams(searchParams.toString());
    if (nextQuery.trim()) params.set("q", nextQuery);
    else params.delete("q");
    if (nextStatus === "all") params.delete("status");
    else params.set("status", nextStatus);
    const suffix = params.toString();
    router.replace(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false });
  };

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

  const updateStatus = async (
    id: string,
    status: typeof statuses[number],
    closure?: { outcomeCode: FeedbackClosureOutcome; userReply?: string }
  ) => {
    if (busyId) return false;
    setBusyId(id);
    try {
      const response = await fetch(`/api/admin/feedback/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          ...(closure
            ? {
                outcomeCode: closure.outcomeCode,
                ...(closure.userReply?.trim()
                  ? { userReply: closure.userReply.trim() }
                  : {}),
              }
            : {}),
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        feedback?: FeedbackRow;
        userNotification?: UserNotificationResult;
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
      // The status change succeeded whatever happened to the email; the
      // sentence about the email only ever adds detail.
      dispatchAppToast(
        `Feedback status updated.${userNotificationSentence(data.userNotification)}`,
        "success"
      );
      return true;
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Failed to update feedback.",
        "error"
      );
      return false;
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

  const exportCsv = () => {
    const csv = [
      ["id", "createdAt", "email", "type", "status", "traceId", "modelId", "plan", "path", "message"],
      ...filteredItems.map((feedback) => [
        feedback.id,
        feedback.createdAt,
        feedback.email || "",
        feedback.type,
        feedback.status,
        feedback.traceId || "",
        feedback.modelId || "",
        feedback.plan || "",
        feedback.path || "",
        feedback.message,
      ]),
    ]
      .map((line) => line.map(escapeCsv).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "tomverse-admin-feedback.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section id="feedback" className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
            Feedback
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">Support inbox</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            Review user feedback, copy reproduction context, and move issues through
            support states without leaving the Admin console.
          </p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-bold text-amber-200">
          <MessageSquare className="h-3.5 w-3.5" />
          {openCount} open
        </span>
        <button
          type="button"
          onClick={exportCsv}
          className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-bold text-zinc-200 transition hover:bg-zinc-900"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </button>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_auto]">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(event) => {
              const value = event.target.value;
              setQuery(value);
              updateLocation(value, statusFilter);
            }}
            placeholder="Search email, trace ID, model, path, message..."
            className="h-11 w-full rounded-xl border border-zinc-800 bg-zinc-950 pl-10 pr-3 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          {(["all", ...statuses] as const).map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => {
                setStatusFilter(status);
                updateLocation(query, status);
              }}
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
                      <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-xs font-bold text-blue-200">
                        {feedback.type}
                      </span>
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${statusClass(feedback.status)}`}>
                        {feedback.status}
                      </span>
                      <span className="text-xs text-zinc-500">
                        {dateLabel(feedback.createdAt)} UTC
                      </span>
                      {/*
                        Whether lifecycle emails can reach this reporter. A
                        capability flag only -- the address itself is already
                        shown once below and is not repeated here.
                      */}
                      <span
                        data-testid="feedback-notify-badge"
                        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-bold ${
                          isNotifiable(feedback)
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                            : "border-zinc-700 bg-zinc-950 text-zinc-500"
                        }`}
                      >
                        <BellRing className="h-3 w-3" />
                        {isNotifiable(feedback)
                          ? "Email updates on"
                          : "No email updates"}
                      </span>
                    </div>
                    <div className="mt-3 text-sm font-bold text-white">
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
                        onClick={() =>
                          isTerminalFeedbackStatus(status)
                            ? // Closing asks for the outcome and the
                              // user-facing reply first; it is never one click.
                              setCloseTarget({ feedback, status })
                            : updateStatus(feedback.id, status)
                        }
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

                {isNotifiable(feedback) && feedback.status === "open" ? (
                  <p
                    data-testid="feedback-reviewing-email-hint"
                    className="mt-2 text-xs font-semibold leading-5 text-blue-200/80"
                  >
                    Moving this report to reviewing (or closing it) emails the
                    reporter a status update.
                  </p>
                ) : null}

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

                {/*
                  Server-side trace evidence, kept visually separate from the
                  reporter's own words above. Everything here is either an
                  authenticated fact from the signed token/evidence row or is
                  explicitly labelled as a client claim. Phase 1 shows
                  observability only -- no auto-fix state exists yet, so none
                  is invented here.
                */}
                {traceVerificationLabel(feedback) ? (
                  <div
                    data-testid="feedback-trace-verification"
                    className="mt-2 grid gap-1.5 rounded-xl border border-zinc-800 bg-zinc-950/70 p-3 text-xs text-zinc-400"
                  >
                    <span className="font-bold text-zinc-200">
                      {traceVerificationLabel(feedback)}
                    </span>
                    <span className="truncate">
                      Trace source:{" "}
                      {feedback.errorReportVerification === "verified"
                        ? "server_generated (authenticated)"
                        : `${feedback.traceProvenance || "unknown"} (client claim)`}
                    </span>
                    {feedback.clientErrorCode ? (
                      <span className="truncate">
                        Client-classified code: {feedback.clientErrorCode}
                      </span>
                    ) : null}
                    {evidenceAvailabilityLabel(feedback.evidenceAvailability) ? (
                      <span className="truncate">
                        {evidenceAvailabilityLabel(feedback.evidenceAvailability)}
                      </span>
                    ) : null}
                    {feedback.autoFixCase ? (
                      <span
                        data-testid="feedback-autofix-case"
                        className="truncate"
                      >
                        Shadow diagnosis (observation only, no auto-fix):{" "}
                        {feedback.autoFixCase.state}
                        {feedback.autoFixCase.classification
                          ? ` — ${feedback.autoFixCase.classification}`
                          : ""}
                        {feedback.autoFixCase.ineligibilityReason
                          ? ` (${feedback.autoFixCase.ineligibilityReason})`
                          : ""}
                      </span>
                    ) : null}
                    {feedback.traceEvidence ? (
                      <div
                        data-testid="feedback-trace-evidence"
                        className="mt-1 grid gap-1 border-t border-zinc-800 pt-2 md:grid-cols-2"
                      >
                        <span className="truncate">
                          Server code: {feedback.traceEvidence.errorCode || "-"}{" "}
                          ({feedback.traceEvidence.classificationSource})
                        </span>
                        <span className="truncate">
                          Route: {feedback.traceEvidence.routeClass}
                          {feedback.traceEvidence.phase
                            ? ` / ${feedback.traceEvidence.phase}`
                            : ""}
                        </span>
                        <span className="truncate">
                          Release: {feedback.traceEvidence.release || "-"} (
                          {feedback.traceEvidence.environment})
                        </span>
                        <span className="truncate">
                          Provider: {feedback.traceEvidence.provider || "-"} /{" "}
                          {feedback.traceEvidence.modelId || "-"}
                        </span>
                        <span className="truncate">
                          Occurred: {feedback.traceEvidence.occurredAt}
                        </span>
                        <span className="truncate">
                          Sentry event:{" "}
                          {feedback.traceEvidence.sentryEventId || "-"}
                        </span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="mt-3">
                  <AdminNotesBox targetType="Feedback" targetId={feedback.id} />
                </div>
              </article>
            );
          })
        )}
      </div>

      {closeTarget ? (
        <FeedbackCompletionDialog
          feedback={closeTarget.feedback}
          status={closeTarget.status}
          busy={busyId === closeTarget.feedback.id}
          onCancel={() => setCloseTarget(null)}
          onConfirm={async (closure) => {
            const done = await updateStatus(
              closeTarget.feedback.id,
              closeTarget.status,
              closure
            );
            if (done) setCloseTarget(null);
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * The small closing dialog: outcome code, the user-facing reply, and a preview
 * of exactly what the reporter will be emailed. The preview is rendered by the
 * same builder the delivery queue uses, in the language the report was
 * submitted in, so what the admin approves is what gets sent.
 *
 * The reply here is the SUBMITTER-facing text. Internal admin notes live in
 * AdminNotesBox and never reach an email.
 */
function FeedbackCompletionDialog({
  feedback,
  status,
  busy,
  onCancel,
  onConfirm,
}: {
  feedback: FeedbackRow;
  status: "resolved" | "closed";
  busy: boolean;
  onCancel: () => void;
  onConfirm: (closure: {
    outcomeCode: FeedbackClosureOutcome;
    userReply?: string;
  }) => void;
}) {
  const [outcomeCode, setOutcomeCode] = useState<FeedbackClosureOutcome>(
    feedback.type === "bug" ? "fixed" : "answered"
  );
  const [userReply, setUserReply] = useState(feedback.userReply || "");
  const selectRef = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    selectRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onCancel]);

  const replyState = feedbackUserReplyState(userReply);
  const replyValid = replyState === "empty" || replyState === "ready";
  const notifiable = isNotifiable(feedback);
  const alreadyCompleted =
    isTerminalFeedbackStatus(feedback.status) || Boolean(feedback.closureOutcome);
  const preview = useMemo(
    () =>
      buildFeedbackLifecycleEmail("completed", {
        reference: feedbackReferenceFromId(feedback.id),
        type: feedback.type,
        language: feedback.language,
        outcomeCode,
        userReply: userReply.trim() || null,
      }),
    [feedback.id, feedback.language, feedback.type, outcomeCode, userReply]
  );

  return (
    <div
      data-testid="feedback-completion-layer"
      className="fixed inset-0 z-[140] flex items-center justify-center bg-black/70 p-4"
    >
      <button
        type="button"
        aria-label="Cancel"
        onClick={onCancel}
        className="absolute inset-0 h-full w-full cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Close feedback as ${status}`}
        data-testid="feedback-completion-dialog"
        className="relative z-10 max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-black capitalize text-white">
              Mark as {status}
            </h3>
            <p className="mt-1 text-xs leading-5 text-zinc-400">
              {notifiable
                ? alreadyCompleted
                  ? "This report was already closed once. The completion email is sent only for the first closure, so no new email will go out."
                  : "The reporter opted into email updates. Confirming sends the completion email previewed below."
                : "This reporter has no email updates. The status changes without sending anything."}
            </p>
          </div>
          <button
            type="button"
            data-testid="feedback-completion-cancel"
            onClick={onCancel}
            aria-label="Cancel"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-zinc-500 transition hover:bg-zinc-900"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="mt-4 block text-xs font-bold uppercase tracking-[0.14em] text-zinc-400">
          Outcome
          <select
            ref={selectRef}
            data-testid="feedback-completion-outcome"
            value={outcomeCode}
            onChange={(event) =>
              setOutcomeCode(event.target.value as FeedbackClosureOutcome)
            }
            className="mt-1.5 h-11 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-white outline-none transition focus:border-blue-500"
          >
            {FEEDBACK_CLOSURE_OUTCOMES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>

        <label className="mt-4 block text-xs font-bold uppercase tracking-[0.14em] text-zinc-400">
          Reply to the reporter (optional, included in the email)
          <textarea
            data-testid="feedback-completion-reply"
            value={userReply}
            onChange={(event) => setUserReply(event.target.value)}
            rows={3}
            maxLength={FEEDBACK_USER_REPLY_MAX_LENGTH}
            aria-invalid={!replyValid ? true : undefined}
            className="mt-1.5 w-full resize-y rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm leading-6 text-white outline-none transition focus:border-blue-500"
          />
        </label>
        <p
          data-testid="feedback-completion-reply-hint"
          role="status"
          className={`mt-1 text-xs font-semibold leading-5 ${
            replyValid ? "text-zinc-500" : "text-amber-300"
          }`}
        >
          {replyState === "tooShort"
            ? `A reply needs at least ${FEEDBACK_USER_REPLY_MIN_LENGTH} characters, or leave it empty.`
            : `Visible to the reporter. Never paste internal notes, trace IDs or diagnostics here. ${userReply.trim().length}/${FEEDBACK_USER_REPLY_MAX_LENGTH}`}
        </p>

        {notifiable && !alreadyCompleted ? (
          <div
            data-testid="feedback-completion-preview"
            className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/70 p-3"
          >
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-zinc-400">
              Email preview ({feedback.language})
            </p>
            <p className="mt-2 text-sm font-bold text-white">{preview.subject}</p>
            <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap font-sans text-xs leading-5 text-zinc-300">
              {preview.text}
            </pre>
          </div>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-zinc-700 px-4 py-2 text-xs font-bold text-zinc-200 transition hover:bg-zinc-900"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="feedback-completion-confirm"
            disabled={busy || !replyValid}
            onClick={() =>
              onConfirm({
                outcomeCode,
                ...(userReply.trim() ? { userReply: userReply.trim() } : {}),
              })
            }
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Mark {status}
          </button>
        </div>
      </div>
    </div>
  );
}
