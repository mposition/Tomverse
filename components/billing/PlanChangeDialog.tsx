"use client";

/**
 * The Pro <-> Max change screen.
 *
 * This is the screen `resolvePlanCtaState()`'s `change_plan` branch opens, and
 * it replaces a CTA that used to send subscribers to support. Three things it
 * has to get right, all of them decided in `docs/policy/plan-change.md`:
 *
 * 1. **The amount is quoted before anything is charged.** The preview endpoint
 *    changes nothing, and the confirm is the customer's own second action.
 * 2. **An upgrade is not "done" when it is confirmed.** The plan moves when the
 *    invoice is paid, so the success state says "waiting for your payment"
 *    unless the server reports the change already applied.
 * 3. **Resuming a cancelled subscription is a separate decision.** It has its
 *    own checkbox with its own label, and the confirm button never implies it.
 *
 * The server decides everything of consequence -- direction, price, whether the
 * change is allowed at all -- and decides it again at confirm time. This
 * component renders those answers; it does not compute them.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ArrowRight, CalendarClock, X } from "lucide-react";
import {
  billingMinorToMajor,
  formatBillingAmount,
  normalizeBillingCurrency,
} from "@/lib/billingMarkets";
import { buildPlanChangeSupportHref } from "@/lib/purchaseIntent";
import { useModalDialog } from "@/components/useModalDialog";
import {
  normalizePlanChangeErrorCode,
  planChangeNeedsSupport,
  planChangeText,
  type PlanChangeCopyErrorCode,
} from "@/components/billing/planChangeCopy";
import { discardResponseBody } from "@/lib/discardResponseBody";

type Quote = {
  requestId: string;
  direction: "upgrade" | "downgrade";
  execution: "immediate_upgrade" | "scheduled_downgrade";
  fromTier: "Pro" | "Max";
  toTier: "Pro" | "Max";
  billingInterval: "monthly" | "annual";
  currency: string;
  amountDueMinor: number | null;
  credits: {
    monthlyPlanCredits: number;
    remainingPlanCredits: number;
    overageCredits: number;
  } | null;
  effectiveAt: string | null;
  renewal:
    | "unaffected"
    | "cancellation_preserved"
    | "cancellation_cleared_by_explicit_consent";
  expiresAt: string;
};

type Reservation = {
  requestId: string;
  direction: "upgrade" | "downgrade";
  execution: "immediate_upgrade" | "scheduled_downgrade";
  fromTier: "Pro" | "Max";
  toTier: "Pro" | "Max";
  billingInterval: "monthly" | "annual";
  status: "pending" | "applied" | "cancelled" | "expired" | "failed";
  appliesAt: string | null;
  cancellable: boolean;
};

type Stage = "loading" | "quote" | "reserved" | "cancelled" | "error";

const formatAmount = (amountMinor: number, currency: string): string => {
  const normalized = normalizeBillingCurrency(currency);
  if (!normalized) return String(amountMinor);
  return formatBillingAmount(
    billingMinorToMajor(amountMinor, normalized),
    normalized
  );
};

const formatDate = (value: string | null, lang: string): string => {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat(lang || "en", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(parsed);
};

const readCode = (payload: unknown): PlanChangeCopyErrorCode =>
  normalizePlanChangeErrorCode(
    payload && typeof payload === "object"
      ? (payload as { code?: unknown }).code
      : undefined
  );

export function PlanChangeDialog({
  open,
  onOpenChange,
  targetTier,
  billingInterval,
  lang,
  onSettled,
  returnFocusToRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetTier: "Pro" | "Max";
  billingInterval: "monthly" | "annual";
  lang: string;
  /** Called after a confirm or cancel so the page can refresh its account state. */
  onSettled?: () => void;
  /** Explicit CTA for touch Safari, where tapping a button need not focus it. */
  returnFocusToRef?: RefObject<HTMLElement | null>;
}) {
  const text = planChangeText(lang);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  // Taken before any state is committed, and deliberately not released on
  // success: a second click while the request is in flight would confirm the
  // same quote twice.
  const inFlightRef = useRef(false);

  const [stage, setStage] = useState<Stage>("loading");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [errorCode, setErrorCode] = useState<PlanChangeCopyErrorCode | null>(null);
  const [resumeRenewal, setResumeRenewal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  useModalDialog({
    open,
    onClose: close,
    dialogRef,
    panelRef: dialogRef,
    initialFocusRef: closeButtonRef,
    returnFocusRef: returnFocusToRef,
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();

    queueMicrotask(() => {
      if (cancelled) return;
      setStage("loading");
      setErrorCode(null);
      setQuote(null);
      setReservation(null);
      setResumeRenewal(false);
      setBusy(false);
      inFlightRef.current = false;
    });

    const run = async () => {
      // A change already in flight wins over a new quote: offering to start a
      // second one is exactly what the server refuses, and showing the
      // refusal after the customer has read a price is worse than never
      // showing the price.
      const existing = await fetch("/api/billing/plan-change", {
        cache: "no-store",
        signal: controller.signal,
      })
        .then((response) =>
        response.ok ? response.json() : discardResponseBody(response).then(() => null)
      )
        .catch(() => null);
      if (cancelled) return;
      if (existing?.reservation) {
        setReservation(existing.reservation as Reservation);
        setStage("reserved");
        return;
      }

      const response = await fetch("/api/billing/plan-change/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ targetTier, billingInterval }),
      });
      const data = await response.json().catch(() => null);
      if (cancelled) return;
      if (!response.ok || !data?.quote) {
        setErrorCode(readCode(data));
        setStage("error");
        return;
      }
      setQuote(data.quote as Quote);
      setStage("quote");
    };

    void run().catch((requestError) => {
      if (cancelled || (requestError as Error).name === "AbortError") return;
      setErrorCode(
        requestError instanceof TypeError ? "NETWORK_ERROR" : "STRIPE_ERROR"
      );
      setStage("error");
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [attempt, billingInterval, open, targetTier]);

  const confirm = async () => {
    if (!quote || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setErrorCode(null);
    try {
      const response = await fetch("/api/billing/plan-change/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: quote.requestId,
          // Only ever what the customer ticked. The confirm button is consent
          // to change plan and nothing else.
          ...(resumeRenewal ? { resumeRenewal: true } : {}),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.reservation) {
        // Not reported to product analytics: the funnel schema's error codes
        // describe the purchase funnel, and stretching them to cover plan
        // changes would file distinct refusals under a name that means
        // something else. The refusal is already in the server logs and on the
        // PlanChangeRequest row.
        setErrorCode(readCode(data));
        setStage("error");
        inFlightRef.current = false;
        setBusy(false);
        return;
      }
      setReservation(data.reservation as Reservation);
      setStage("reserved");
      setBusy(false);
      onSettled?.();
    } catch (requestError) {
      setErrorCode(
        requestError instanceof TypeError ? "NETWORK_ERROR" : "STRIPE_ERROR"
      );
      setStage("error");
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  const cancelScheduled = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setErrorCode(null);
    try {
      const response = await fetch("/api/billing/plan-change", {
        method: "DELETE",
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setErrorCode(readCode(data));
        setStage("error");
        inFlightRef.current = false;
        setBusy(false);
        return;
      }
      setStage("cancelled");
      setBusy(false);
      onSettled?.();
    } catch (requestError) {
      setErrorCode(
        requestError instanceof TypeError ? "NETWORK_ERROR" : "STRIPE_ERROR"
      );
      setStage("error");
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  if (!open || typeof document === "undefined") return null;

  const isUpgrade = (quote?.direction ?? reservation?.direction) === "upgrade";
  const shownTier = quote?.toTier ?? reservation?.toTier ?? targetTier;
  const title = isUpgrade
    ? text.upgradeTitle(shownTier)
    : text.downgradeTitle(shownTier);
  const effectiveDate = formatDate(
    quote?.effectiveAt ?? reservation?.appliesAt ?? null,
    lang
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/65 p-3 backdrop-blur-sm sm:items-center"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-change-title"
        data-testid="plan-change-modal"
        data-stage={stage}
        data-direction={isUpgrade ? "upgrade" : "downgrade"}
        className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-3xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
      >
        <div className="flex items-start justify-between gap-4">
          <h2
            id="plan-change-title"
            className="flex min-w-0 items-center gap-2 text-xl font-black text-zinc-950 dark:text-white"
          >
            {isUpgrade ? (
              <ArrowRight className="h-5 w-5 shrink-0 text-accent-promotion-500" />
            ) : (
              <CalendarClock className="h-5 w-5 shrink-0 text-accent-promotion-500" />
            )}
            <span className="min-w-0 break-words">{title}</span>
          </h2>
          {/* UI-TOUCH-001's 44px floor: the only pointer-driven way out. */}
          <button
            ref={closeButtonRef}
            type="button"
            onClick={close}
            aria-label={text.close}
            data-testid="plan-change-modal-close"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl p-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {stage === "loading" ? (
          <p
            role="status"
            data-testid="plan-change-loading"
            className="mt-5 text-sm text-zinc-500 dark:text-zinc-400"
          >
            {text.loading}
            <span className="sr-only"> {text.loadingStatus}</span>
          </p>
        ) : null}

        {stage === "quote" && quote ? (
          <div className="mt-5">
            {quote.amountDueMinor !== null ? (
              <div
                data-testid="plan-change-amount"
                className="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800"
              >
                <p className="text-xs font-bold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  {text.dueNow}
                </p>
                <p className="mt-1 text-2xl font-black text-zinc-950 dark:text-white">
                  {formatAmount(quote.amountDueMinor, quote.currency)}
                </p>
              </div>
            ) : null}

            {/* Present only when the change lands now. A scheduled downgrade
                leaves this month's allowance alone, so there is no honest
                number to put here -- see the quote's `credits` field. */}
            {quote.credits ? (
            <div
              data-testid="plan-change-credits"
              className="mt-3 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800"
            >
              <p className="text-xs font-bold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                {text.creditsLabel}
              </p>
              <p className="mt-1 text-sm font-semibold text-zinc-950 dark:text-white">
                {text.creditsRemaining(
                  quote.credits.remainingPlanCredits,
                  quote.credits.monthlyPlanCredits
                )}
              </p>
              {quote.credits.overageCredits > 0 ? (
                <p
                  data-testid="plan-change-credits-overage"
                  className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400"
                >
                  {text.creditsOverageNotice}
                </p>
              ) : null}
            </div>
            ) : null}

            <p
              data-testid="plan-change-body"
              className="mt-4 text-sm leading-6 text-zinc-700 dark:text-zinc-200"
            >
              {isUpgrade
                ? text.upgradeBody(quote.toTier)
                : text.downgradeBody(quote.toTier, effectiveDate)}
            </p>

            <p className="mt-2 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
              {quote.effectiveAt
                ? text.effectiveOn(effectiveDate)
                : text.effectiveImmediately}
            </p>

            {/* Its own control, its own label. An upgrade confirm must never
                double as consent to start renewing again. */}
            {quote.renewal === "cancellation_preserved" ? (
              <div className="mt-4 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
                <label className="flex items-start gap-3 text-sm font-bold text-zinc-900 dark:text-zinc-100">
                  <input
                    type="checkbox"
                    data-testid="plan-change-resume-renewal"
                    checked={resumeRenewal}
                    onChange={(event) => setResumeRenewal(event.target.checked)}
                    className="mt-1 h-5 w-5 shrink-0 rounded border-zinc-300 dark:border-zinc-700"
                  />
                  <span className="min-w-0">{text.resumeRenewalLabel}</span>
                </label>
                <p className="mt-2 text-xs leading-5 text-zinc-600 dark:text-zinc-300">
                  {resumeRenewal
                    ? text.resumeRenewalHint
                    : text.cancellationPreservedNotice}
                </p>
              </div>
            ) : null}

            <button
              type="button"
              data-testid="plan-change-confirm"
              disabled={busy}
              onClick={() => void confirm()}
              className="mt-5 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-accent-promotion-600 px-4 py-3 text-center text-sm font-bold text-white transition hover:bg-accent-promotion-700 disabled:cursor-progress disabled:opacity-70"
            >
              {busy
                ? text.working
                : isUpgrade
                  ? text.confirmUpgrade(quote.toTier)
                  : text.confirmDowngrade(quote.toTier)}
            </button>
          </div>
        ) : null}

        {stage === "reserved" && reservation ? (
          <div className="mt-5" data-testid="plan-change-reserved">
            {/* 700 rather than 900: the typography contract reserves
                font-black for headline-sized text, and this sits at 16px. */}
            <h3 className="text-base font-bold text-zinc-950 dark:text-white">
              {reservation.status === "applied"
                ? text.upgradeDoneTitle(reservation.toTier)
                : reservation.execution === "immediate_upgrade"
                  ? // Confirmed is not applied: the plan moves when the invoice
                    // is paid, so saying "upgraded" here would be a claim the
                    // server has refused to make.
                    text.pendingPaymentTitle
                  : text.scheduledTitle(reservation.toTier)}
            </h3>
            <p className="mt-2 text-sm leading-6 text-zinc-700 dark:text-zinc-200">
              {reservation.status === "applied"
                ? text.upgradeDoneBody
                : reservation.execution === "immediate_upgrade"
                  ? text.pendingPaymentBody
                  : text.scheduledBody(
                      reservation.toTier,
                      formatDate(reservation.appliesAt, lang)
                    )}
            </p>
            {reservation.cancellable ? (
              <button
                type="button"
                data-testid="plan-change-cancel-scheduled"
                disabled={busy}
                onClick={() => void cancelScheduled()}
                className="mt-5 inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-zinc-300 px-4 py-3 text-center text-sm font-bold text-zinc-800 transition hover:bg-zinc-100 disabled:cursor-progress disabled:opacity-70 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
              >
                {busy ? text.working : text.cancelScheduled}
              </button>
            ) : null}
          </div>
        ) : null}

        {stage === "cancelled" ? (
          <p
            role="status"
            data-testid="plan-change-cancelled"
            className="mt-5 text-sm leading-6 text-zinc-700 dark:text-zinc-200"
          >
            {text.cancelScheduledDone}
          </p>
        ) : null}

        {stage === "error" && errorCode ? (
          <div className="mt-5" data-testid="plan-change-error" data-error-code={errorCode}>
            <p
              role="alert"
              className="text-sm leading-6 text-red-700 dark:text-red-300"
            >
              {text.errors[errorCode]}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {/* A schedule conflict or a missing price answers the same way
                  every time, so retrying is offered only where it can work. */}
              {planChangeNeedsSupport(errorCode) ? (
                <Link
                  href={buildPlanChangeSupportHref(lang)}
                  data-testid="plan-change-support"
                  className="inline-flex min-h-11 items-center justify-center rounded-xl border border-zinc-300 px-4 py-2 text-sm font-bold text-zinc-800 dark:border-zinc-700 dark:text-zinc-100"
                >
                  {text.contactSupport}
                </Link>
              ) : (
                <button
                  type="button"
                  data-testid="plan-change-retry"
                  onClick={() => {
                    inFlightRef.current = false;
                    setAttempt((value) => value + 1);
                  }}
                  className="inline-flex min-h-11 items-center justify-center rounded-xl border border-zinc-300 px-4 py-2 text-sm font-bold text-zinc-800 dark:border-zinc-700 dark:text-zinc-100"
                >
                  {text.retry}
                </button>
              )}
            </div>
          </div>
        ) : null}
      </section>
    </div>,
    document.body
  );
}
