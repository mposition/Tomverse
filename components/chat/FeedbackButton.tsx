"use client";

import { useState } from "react";
import { LifeBuoy, Send, X } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import { useLanguage } from "@/components/LanguageProvider";

export function FeedbackButton({
  currentModelId,
  currentPlan,
  attachmentCount = 0,
  rawErrorDetails,
  triggerLabel,
  triggerClassName,
}: {
  currentModelId?: string | null;
  currentPlan?: string | null;
  attachmentCount?: number;
  // When set, this button opens in "report this error" mode: the type
  // selector is hidden (always "bug"), a description isn't required, and
  // this raw error text rides along with the submission automatically --
  // the whole point is that the user shouldn't have to copy/paste it
  // themselves.
  rawErrorDetails?: string;
  triggerLabel?: string;
  triggerClassName?: string;
}) {
  const { t } = useLanguage();
  const isErrorReport = Boolean(rawErrorDetails);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"bug" | "feature" | "billing" | "other">("bug");
  const [message, setMessage] = useState("");
  const [traceId, setTraceId] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [detailsCopied, setDetailsCopied] = useState(false);

  const canSubmit = isErrorReport
    ? !isSending
    : message.trim().length >= 5 && !isSending;

  const submit = async () => {
    if (!canSubmit) return;
    setIsSending(true);
    try {
      const description = message.trim() || (isErrorReport ? t("feedback.errorReportDefaultMessage") : "");
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          message: rawErrorDetails
            ? `${description}\n\n---\n${rawErrorDetails}`
            : description,
          traceId: traceId || undefined,
          modelId: currentModelId || undefined,
          plan: currentPlan || undefined,
          hasAttachments: attachmentCount > 0,
          attachmentCount,
          path: window.location.pathname,
          userAgent: navigator.userAgent,
        }),
      });
      if (!response.ok) throw new Error(`Feedback failed: ${response.status}`);
      setOpen(false);
      setMessage("");
      setTraceId("");
      dispatchAppToast(t("feedback.sent"), "success");
    } catch {
      dispatchAppToast(t("feedback.failed"), "error");
    } finally {
      setIsSending(false);
    }
  };

  const copyDetails = async () => {
    if (!rawErrorDetails) return;
    try {
      await navigator.clipboard.writeText(rawErrorDetails);
      setDetailsCopied(true);
      window.setTimeout(() => setDetailsCopied(false), 1_500);
    } catch {
      dispatchAppToast(t("feedback.copyDiagnosticsFailed"), "error");
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (!traceId && typeof window !== "undefined") {
            setTraceId(window.localStorage.getItem("tomverse_last_error_trace_id") || "");
          }
          setType("bug");
          setOpen(true);
        }}
        className={
          triggerClassName ||
          "inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-black text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900"
        }
      >
        <LifeBuoy className="h-4 w-4 text-blue-500" />
        {triggerLabel || t("feedback.button")}
      </button>
      {open && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-black text-zinc-950 dark:text-white">
                  {isErrorReport ? t("feedback.reportErrorTitle") : t("feedback.title")}
                </h2>
                <p className="mt-1 text-sm text-zinc-500">
                  {isErrorReport ? t("feedback.reportErrorDescription") : t("feedback.description")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {!isErrorReport && (
              <select
                value={type}
                onChange={(event) => setType(event.target.value as typeof type)}
                className="mt-4 h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <option value="bug">{t("feedback.problem")}</option>
                <option value="feature">{t("feedback.feature")}</option>
                <option value="billing">{t("feedback.billing")}</option>
                <option value="other">{t("feedback.other")}</option>
              </select>
            )}
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={5}
              placeholder={isErrorReport ? t("feedback.errorReportPlaceholder") : t("feedback.placeholder")}
              className="mt-3 w-full resize-none rounded-xl border border-zinc-200 bg-white p-3 text-sm outline-none focus:border-blue-500 dark:border-zinc-800 dark:bg-zinc-900"
            />
            <input
              value={traceId}
              onChange={(event) => setTraceId(event.target.value)}
              placeholder={t("feedback.tracePlaceholder")}
              className="mt-3 h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-zinc-800 dark:bg-zinc-900"
            />
            <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-400">
              {t("feedback.autoContext")} {currentModelId || "-"} / {currentPlan || "-"} / {t("feedback.attachments")} {attachmentCount} / {typeof window !== "undefined" ? window.location.pathname : "-"}
            </div>
            {isErrorReport && (
              <button
                type="button"
                onClick={copyDetails}
                className="mt-2 text-xs font-bold text-zinc-500 underline underline-offset-2 hover:text-zinc-800 dark:hover:text-zinc-200"
              >
                {detailsCopied ? t("feedback.copyDiagnosticsCopied") : t("feedback.copyDiagnostics")}
              </button>
            )}
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              {t("feedback.send")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
