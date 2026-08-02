"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import { useSession } from "next-auth/react";
import { AlertCircle, LifeBuoy, Loader2, Send, X } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import { useLanguage } from "@/components/LanguageProvider";
import { useTurnstile } from "@/components/chat/useTurnstile";
import { useGuestVerification } from "@/components/chat/GuestVerificationProvider";
import { TurnstileFormSlot } from "@/components/chat/TurnstileFormSlot";
import { useKeyboardInset } from "@/components/chat/useVisualViewport";
import {
  guestVerificationFailureKey,
} from "@/components/chat/guestVerificationCopy";
import {
  isGuestVerificationError,
  type GuestVerificationFailure,
} from "@/components/chat/guestVerificationFailure";
import { submitFeedback } from "@/lib/feedbackClient";
import {
  canSubmitFeedback,
  composeFeedbackMessage,
  feedbackFailureCopyKey,
  feedbackMessageState,
  isPlausibleTraceId,
  sanitizeFeedbackDiagnostics,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  FEEDBACK_MESSAGE_MIN_LENGTH,
  FEEDBACK_TRACE_ID_MAX_LENGTH,
} from "@/lib/feedbackPolicy";

/**
 * The chat feedback modal.
 *
 * Three things here are contractual rather than cosmetic:
 *
 *  - the five-character minimum is product policy. It is enforced twice (here
 *    and by the route's zod schema) and *explained* once, below the textarea,
 *    because a disabled button on its own tells the user nothing.
 *  - a guest submission carries a Turnstile token. `/api/feedback` calls
 *    `ensureGuestVerified` for every unauthenticated caller, so a chat feedback
 *    modal that never asked for one simply could not deliver a guest's report.
 *    It uses the same `support_request` action, and the same hook, as the
 *    marketing support form.
 *  - success and failure are different outcomes for the draft. Only a stored
 *    submission clears the form and closes the dialog; everything else keeps
 *    what the user wrote exactly where it is.
 */

const interpolate = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
    template
  );

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** The portal target never changes; the server simply has none. */
const subscribeToNothing = () => () => {};
const getPortalContainer = () => document.body;
const getServerPortalContainer = () => null;

type SubmitError =
  | { source: "submit"; copyKey: string; reference: string | null }
  | { source: "verification"; copyKey: string; reference: null };

export function FeedbackButton({
  currentModelId,
  currentPlan,
  attachmentCount = 0,
  rawErrorDetails,
  triggerLabel,
  triggerClassName,
  triggerTestId,
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
  triggerTestId?: string;
}) {
  const { t } = useLanguage();
  const { status } = useSession();
  const isErrorReport = Boolean(rawErrorDetails);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"bug" | "feature" | "billing" | "other">("bug");
  const [message, setMessage] = useState("");
  const [traceId, setTraceId] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [detailsCopied, setDetailsCopied] = useState(false);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  /**
   * The diagnostics as they will be sent. Seeded from the sanitiser and then
   * owned by the user: pattern matching cannot know what it missed, and a
   * short secret is exactly the shape no detector can separate from ordinary
   * text. Letting the person delete it is the only complete answer.
   */
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const [attachDiagnostics, setAttachDiagnostics] = useState(true);
  const keyboardInset = useKeyboardInset();

  const baseId = useId();
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;
  const hintId = `${baseId}-hint`;
  const counterId = `${baseId}-counter`;
  const traceHintId = `${baseId}-trace-hint`;
  const errorId = `${baseId}-error`;

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * Synchronous duplicate guard. `isSending` is React state and only lands on
   * the next render, so two clicks (or a click and an Enter) inside the same
   * frame would both pass a state-based check and fire two POSTs.
   */
  const submittingRef = useRef(false);
  /**
   * Whether the dialog is on screen right now. A submission that finishes
   * after the user closed the dialog has nowhere to put an inline message, so
   * it reports through a toast instead -- which is what lets the close control
   * stay live while a request is in flight.
   */
  const openRef = useRef(false);

  const isGuest = status === "unauthenticated";
  // The chat page resolves the Turnstile site key at request time and shares it
  // through the verification coordinator. This modal owns its own widget --
  // the challenge has to appear *inside* the dialog, not behind it -- but it
  // must use the same key rather than the one baked into the client bundle.
  const { siteKey: pageTurnstileSiteKey } = useGuestVerification();
  const {
    containerRef: turnstileContainerRef,
    getToken: getTurnstileToken,
    cancel: cancelVerification,
    failure: verificationFailure,
    isChallengeVisible,
  } = useTurnstile(isGuest && open, "support_request", pageTurnstileSiteKey);

  const container = useSyncExternalStore<HTMLElement | null>(
    subscribeToNothing,
    getPortalContainer,
    getServerPortalContainer
  );

  const errorReportDefaultMessage = t("feedback.errorReportDefaultMessage");
  const messageState = feedbackMessageState(message);
  const canSubmit =
    canSubmitFeedback({
      message,
      isErrorReport,
      defaultMessage: errorReportDefaultMessage,
    }) && !isSending;

  /**
   * The sentence under the textarea. It is never the only signal -- the button
   * is disabled too -- but it is the only one that says *why*, and it is what
   * `aria-describedby` points both the textarea and the send button at.
   */
  const messageHint = useMemo(() => {
    if (isErrorReport && messageState.kind === "empty") {
      return { tone: "neutral" as const, text: t("feedback.errorReportHint") };
    }
    switch (messageState.kind) {
      case "empty":
        return {
          tone: "neutral" as const,
          text: interpolate(t("feedback.messageHelp"), {
            min: FEEDBACK_MESSAGE_MIN_LENGTH,
          }),
        };
      case "tooShort":
        return {
          tone: "warning" as const,
          text: interpolate(t("feedback.messageRemaining"), {
            count: messageState.remaining,
          }),
        };
      case "tooLong":
        return {
          tone: "warning" as const,
          text: interpolate(t("feedback.messageTooLong"), {
            max: FEEDBACK_MESSAGE_MAX_LENGTH,
          }),
        };
      default:
        return { tone: "ready" as const, text: t("feedback.messageReady") };
    }
  }, [isErrorReport, messageState.kind, messageState.remaining, t]);

  const traceIdLooksWrong = !isPlausibleTraceId(traceId);

  /**
   * Exactly what will be attached, after both sanitiser passes. Shown to the
   * user rather than kept behind the scenes: pattern matching only knows the
   * credential formats it was told about, and a person reading their own error
   * text is the last check on whatever slipped through.
   */
  const sanitizedDiagnostics = useMemo(
    () => (rawErrorDetails ? sanitizeFeedbackDiagnostics(rawErrorDetails) : ""),
    [rawErrorDetails]
  );
  /** What is actually attached: the user's edit if they made one. */
  const effectiveDiagnostics = attachDiagnostics
    ? (diagnostics ?? sanitizedDiagnostics)
    : "";

  const closeDialog = useCallback(() => {
    // Closing is never blocked, including mid-flight. The request keeps
    // running -- abandoning a submission the user already committed to would
    // be worse -- and reports its outcome through a toast instead.
    if (submittingRef.current) {
      dispatchAppToast(t("feedback.sendingContinues"), "info");
    }
    setOpen(false);
  }, [t]);

  const openDialog = () => {
    if (!traceId && typeof window !== "undefined") {
      // Auto-filled once, and only into an empty field: a value the user typed
      // or corrected is never overwritten.
      setTraceId(
        window.localStorage.getItem("tomverse_last_error_trace_id") || ""
      );
    }
    setType("bug");
    setDiagnostics(null);
    setAttachDiagnostics(true);
    // The last failure is deliberately kept, alongside the draft it belongs
    // to: someone reopening the dialog is reopening it to retry, and the
    // reason the previous attempt failed is still true until they do. It is
    // cleared the moment a new submission starts.
    setOpen(true);
  };

  // --- dialog behaviour -----------------------------------------------------

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const getFocusableElements = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog) return [] as HTMLElement[];
    return Array.from(
      dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    ).filter((element) => element.offsetParent !== null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        // Captured before anything behind the dialog sees it: on a phone this
        // modal opens over the sidebar drawer, and one Escape closing both
        // would unmount the very control focus has to return to.
        event.stopPropagation();
        closeDialog();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = getFocusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [closeDialog, getFocusableElements, open]);

  // Focus goes back to the control that opened the dialog, however it closed.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    const target = triggerRef.current;
    if (target?.isConnected && !target.disabled) target.focus();
  }, [open]);

  // --- submission -----------------------------------------------------------

  /**
   * Records a failure where the user can actually see it. The state is always
   * set, so reopening the dialog still shows the reason; the toast is added
   * when the dialog is no longer on screen, which is the only channel left
   * once the user has closed it mid-flight.
   */
  const reportFailure = (failure: SubmitError) => {
    setSubmitError(failure);
    if (openRef.current) return;
    const text = failure.reference
      ? interpolate(t(failure.copyKey), { reference: failure.reference })
      : t(failure.copyKey);
    dispatchAppToast(text, "error");
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;
    if (
      !canSubmitFeedback({
        message,
        isErrorReport,
        defaultMessage: errorReportDefaultMessage,
      })
    ) {
      return;
    }

    submittingRef.current = true;
    setIsSending(true);
    setSubmitError(null);

    try {
      let turnstileToken: string | undefined;
      if (isGuest) {
        try {
          turnstileToken = await getTurnstileToken();
        } catch (error) {
          const failure = isGuestVerificationError(error)
            ? error.kind
            : ("failed" as GuestVerificationFailure);
          reportFailure({
            source: "verification",
            copyKey: guestVerificationFailureKey(failure, "feedback"),
            reference: null,
          });
          return;
        }
      }

      const description =
        message.trim() || (isErrorReport ? errorReportDefaultMessage : "");
      const outcome = await submitFeedback({
        type,
        message: composeFeedbackMessage({
          description,
          // Already sanitised, and possibly edited or removed by the user.
          rawErrorDetails: effectiveDiagnostics || undefined,
        }),
        traceId: traceId.trim().slice(0, FEEDBACK_TRACE_ID_MAX_LENGTH) || undefined,
        modelId: currentModelId || undefined,
        plan: currentPlan || undefined,
        hasAttachments: attachmentCount > 0,
        attachmentCount,
        path: window.location.pathname,
        userAgent: navigator.userAgent,
        ...(turnstileToken ? { turnstileToken } : {}),
      });

      if (!outcome.ok) {
        reportFailure({
          source: "submit",
          copyKey: feedbackFailureCopyKey(outcome.failure),
          reference: outcome.reference,
        });
        return;
      }

      setOpen(false);
      setMessage("");
      setTraceId("");
      setSubmitError(null);
      dispatchAppToast(
        outcome.reference
          ? interpolate(t("feedback.sentWithReference"), {
              reference: outcome.reference,
            })
          : t("feedback.sent"),
        "success"
      );
    } finally {
      submittingRef.current = false;
      setIsSending(false);
    }
  };

  const copyDetails = async () => {
    // Copies what is actually attached, not the raw text: the button sits next
    // to the preview and the two must agree.
    if (!effectiveDiagnostics) return;
    try {
      await navigator.clipboard.writeText(effectiveDiagnostics);
      setDetailsCopied(true);
      window.setTimeout(() => setDetailsCopied(false), 1_500);
    } catch {
      dispatchAppToast(t("feedback.copyDiagnosticsFailed"), "error");
    }
  };

  // --- render ---------------------------------------------------------------

  const fieldClassName =
    "w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-base outline-none transition focus:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60 sm:text-sm dark:border-zinc-800 dark:bg-zinc-900";

  const hintToneClassName =
    messageHint.tone === "warning"
      ? "text-amber-700 dark:text-amber-300"
      : messageHint.tone === "ready"
        ? "text-zinc-600 dark:text-zinc-300"
        : "text-zinc-500 dark:text-zinc-400";

  const dialog =
    open && container
      ? createPortal(
          <div
            data-testid="feedback-dialog-layer"
            className="fixed inset-0 z-[130] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
            style={
              keyboardInset > 0
                ? { paddingBottom: `${keyboardInset + 8}px` }
                : undefined
            }
          >
            <button
              type="button"
              data-testid="feedback-dialog-backdrop"
              aria-label={t("feedback.close")}
              onClick={closeDialog}
              className="absolute inset-0 h-full w-full cursor-default"
            />
            <div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={descriptionId}
              data-testid="feedback-dialog"
              className="relative z-10 max-h-[calc(100dvh-1rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-2xl border border-zinc-200 bg-white p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl sm:pb-5"
              style={
                keyboardInset > 0
                  ? {
                      maxHeight: `calc(100dvh - ${keyboardInset + 16}px)`,
                    }
                  : undefined
              }
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2
                    id={titleId}
                    className="text-lg font-black text-zinc-950 break-keep dark:text-white"
                  >
                    {isErrorReport
                      ? t("feedback.reportErrorTitle")
                      : t("feedback.title")}
                  </h2>
                  <p
                    id={descriptionId}
                    className="mt-1 text-sm leading-6 text-zinc-500 break-keep dark:text-zinc-400"
                  >
                    {isErrorReport
                      ? t("feedback.reportErrorDescription")
                      : t("feedback.description")}
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="feedback-close"
                  onClick={closeDialog}
                  aria-label={t("feedback.close")}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-zinc-500 transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-zinc-900"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>

              <form onSubmit={handleSubmit} noValidate>
                {/*
                  One disabled switch for the whole form while a submission is
                  in flight, so the type selector, the textarea and the trace
                  field can never disagree about whether the form is busy.
                */}
                <fieldset disabled={isSending} className="min-w-0 border-0 p-0">
                  <legend className="sr-only">
                    {isErrorReport
                      ? t("feedback.reportErrorTitle")
                      : t("feedback.title")}
                  </legend>

                  {!isErrorReport && (
                    <label className="mt-4 block text-sm font-bold text-zinc-700 dark:text-zinc-200">
                      {t("feedback.typeLabel")}
                      <select
                        data-testid="feedback-type"
                        value={type}
                        onChange={(event) =>
                          setType(event.target.value as typeof type)
                        }
                        className={`mt-1.5 min-h-11 ${fieldClassName}`}
                      >
                        <option value="bug">{t("feedback.problem")}</option>
                        <option value="feature">{t("feedback.feature")}</option>
                        <option value="billing">{t("feedback.billing")}</option>
                        <option value="other">{t("feedback.other")}</option>
                      </select>
                    </label>
                  )}

                  <label
                    htmlFor={`${baseId}-message`}
                    className="mt-4 block text-sm font-bold text-zinc-700 dark:text-zinc-200"
                  >
                    {t("feedback.messageLabel")}
                  </label>
                  <textarea
                    id={`${baseId}-message`}
                    ref={textareaRef}
                    data-testid="feedback-message"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    rows={5}
                    maxLength={FEEDBACK_MESSAGE_MAX_LENGTH}
                    aria-describedby={`${hintId} ${counterId}`}
                    aria-invalid={
                      !isErrorReport && messageState.kind !== "ready"
                        ? true
                        : undefined
                    }
                    placeholder={
                      isErrorReport
                        ? t("feedback.errorReportPlaceholder")
                        : t("feedback.placeholder")
                    }
                    className={`mt-1.5 resize-none leading-6 ${fieldClassName}`}
                  />
                  <div className="mt-1.5 flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    {/*
                      role="status" makes this a polite live region: the state
                      change is announced, and the same node is what
                      aria-describedby points the textarea and the send button
                      at. Colour is never the only carrier -- the sentence
                      itself changes.
                    */}
                    <p
                      id={hintId}
                      role="status"
                      data-testid="feedback-message-hint"
                      data-tone={messageHint.tone}
                      className={`min-w-0 flex-1 text-xs font-semibold leading-5 break-keep ${hintToneClassName}`}
                    >
                      {messageHint.text}
                    </p>
                    <span
                      id={counterId}
                      data-testid="feedback-message-counter"
                      className="shrink-0 text-xs font-semibold leading-5 tabular-nums text-zinc-500 dark:text-zinc-400"
                    >
                      {interpolate(t("feedback.messageCounter"), {
                        count: messageState.trimmedLength.toLocaleString("en-US"),
                        max: FEEDBACK_MESSAGE_MAX_LENGTH.toLocaleString("en-US"),
                      })}
                    </span>
                  </div>

                  <label
                    htmlFor={`${baseId}-trace`}
                    className="mt-4 block text-sm font-bold text-zinc-700 dark:text-zinc-200"
                  >
                    {t("feedback.traceLabel")}
                  </label>
                  <input
                    id={`${baseId}-trace`}
                    data-testid="feedback-trace"
                    value={traceId}
                    onChange={(event) => setTraceId(event.target.value)}
                    maxLength={FEEDBACK_TRACE_ID_MAX_LENGTH}
                    aria-describedby={traceHintId}
                    placeholder={t("feedback.tracePlaceholder")}
                    className={`mt-1.5 min-h-11 ${fieldClassName}`}
                  />
                  <p
                    id={traceHintId}
                    role="status"
                    data-testid="feedback-trace-hint"
                    className="mt-1.5 text-xs font-semibold leading-5 text-zinc-500 break-keep dark:text-zinc-400"
                  >
                    {traceIdLooksWrong
                      ? t("feedback.traceFormatHint")
                      : t("feedback.traceOptionalHint")}
                  </p>

                  <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-500 break-keep dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-400">
                    {t("feedback.autoContext")} {currentModelId || "-"} /{" "}
                    {currentPlan || "-"} / {t("feedback.attachments")}{" "}
                    {attachmentCount} /{" "}
                    {typeof window !== "undefined"
                      ? window.location.pathname
                      : "-"}
                  </div>

                  {/*
                    The diagnostics are attached automatically, so without this
                    nobody ever sees what actually leaves the browser. The
                    sanitiser removes the credential shapes it can recognise;
                    a reader is the only check on the ones it cannot, and the
                    field is editable so they can act on what they find.
                  */}
                  {isErrorReport && sanitizedDiagnostics && (
                    <details
                      data-testid="feedback-diagnostics"
                      className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/70"
                    >
                      <summary className="min-h-11 cursor-pointer list-none py-2 text-xs font-bold text-zinc-600 break-keep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-zinc-300">
                        {t("feedback.diagnosticsPreview")}
                      </summary>
                      <p
                        id={`${baseId}-diagnostics-note`}
                        className="mt-1 text-xs leading-5 text-zinc-500 break-keep dark:text-zinc-400"
                      >
                        {t("feedback.diagnosticsPreviewNote")}
                      </p>
                      <label className="mt-2 flex items-start gap-2 text-xs font-semibold leading-5 text-zinc-600 break-keep dark:text-zinc-300">
                        <input
                          type="checkbox"
                          data-testid="feedback-diagnostics-attach"
                          checked={attachDiagnostics}
                          onChange={(event) =>
                            setAttachDiagnostics(event.target.checked)
                          }
                          className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
                        />
                        {t("feedback.diagnosticsAttach")}
                      </label>
                      {attachDiagnostics ? (
                        <textarea
                          data-testid="feedback-diagnostics-body"
                          value={effectiveDiagnostics}
                          onChange={(event) => setDiagnostics(event.target.value)}
                          rows={6}
                          aria-label={t("feedback.diagnosticsEditLabel")}
                          aria-describedby={`${baseId}-diagnostics-note`}
                          spellCheck={false}
                          className="mt-2 max-h-48 w-full resize-y overflow-auto rounded-lg border border-zinc-200 bg-white p-2 font-mono text-[11px] leading-5 text-zinc-600 outline-none focus:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
                        />
                      ) : (
                        <p
                          data-testid="feedback-diagnostics-omitted"
                          className="mt-2 text-xs font-semibold leading-5 text-zinc-500 break-keep dark:text-zinc-400"
                        >
                          {t("feedback.diagnosticsOmitted")}
                        </p>
                      )}
                      {attachDiagnostics ? (
                        <button
                          type="button"
                          data-testid="feedback-copy-diagnostics"
                          onClick={copyDetails}
                          className="mt-2 min-h-11 text-xs font-bold text-zinc-500 underline underline-offset-2 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:text-zinc-200"
                        >
                          {detailsCopied
                            ? t("feedback.copyDiagnosticsCopied")
                            : t("feedback.copyDiagnostics")}
                        </button>
                      ) : null}
                    </details>
                  )}
                </fieldset>

                <TurnstileFormSlot
                  containerRef={turnstileContainerRef}
                  isChallengeVisible={isChallengeVisible}
                  failure={verificationFailure}
                  surface="feedback"
                  onCancel={cancelVerification}
                  testId="feedback-verification"
                />

                {submitError ? (
                  <p
                    id={errorId}
                    role="alert"
                    data-testid="feedback-submit-error"
                    className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold leading-5 text-red-700 break-keep dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
                  >
                    <AlertCircle
                      className="mt-0.5 h-4 w-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span>
                      {submitError.reference
                        ? interpolate(t(submitError.copyKey), {
                            reference: submitError.reference,
                          })
                        : t(submitError.copyKey)}
                    </span>
                  </p>
                ) : null}

                <button
                  type="submit"
                  data-testid="feedback-submit"
                  disabled={!canSubmit}
                  aria-describedby={
                    submitError ? `${hintId} ${errorId}` : hintId
                  }
                  className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-zinc-950"
                >
                  {isSending ? (
                    <Loader2
                      className="h-4 w-4 motion-safe:animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Send className="h-4 w-4" aria-hidden="true" />
                  )}
                  {isSending ? t("feedback.sending") : t("feedback.send")}
                </button>
              </form>
            </div>
          </div>,
          container
        )
      : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid={triggerTestId}
        onClick={openDialog}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={
          triggerClassName ||
          "inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-bold text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900"
        }
      >
        <LifeBuoy className="h-4 w-4 text-blue-500" aria-hidden="true" />
        {triggerLabel || t("feedback.button")}
      </button>
      {dialog}
    </>
  );
}
