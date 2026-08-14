"use client";

import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Eye,
  EyeOff,
  Loader2,
  MinusCircle,
  Stethoscope,
  XCircle,
} from "lucide-react";
import type { BillingPromotionConfig } from "@/lib/billingConfig";
import { BILLING_CURRENCIES, type BillingCurrency } from "@/lib/billingMarkets";
import { dispatchAppToast } from "@/lib/appToast";
import {
  currentPromotionDraftState,
  serverPromotionDraftState,
  subscribeToPromotionDraftState,
} from "@/lib/promotionDiagnosticsEvents";
import type {
  DiagnosticCheck,
  DiagnosticStatus,
  PromotionDiagnosticsReport,
} from "@/lib/promotionDiagnosticsCore";

/**
 * "Promotion diagnostics" -- the read-only answer to a promotion that validates
 * and then refuses at Checkout.
 *
 * It lives inside Billing's Promotions section because that is where promotions
 * live (`docs/ui-contracts/admin-console-ia.md`); it is not a new top-level
 * entry and adds no sidebar row. It renders no control that writes: there is no
 * `--apply`, no "adopt this object", no deactivate. Every repair this panel can
 * describe is described as a command an operator runs deliberately, with a
 * reason, somewhere this console cannot reach.
 */

type DiagnosticsResponse = {
  ok: true;
  promotion: {
    id: string;
    code: string;
    fulfillmentType: "stripe_subscription" | "internal_pass";
    appliesToPlanIds: string[];
    stripeCouponId: string | null;
    stripePromotionCodeId: string | null;
  };
  planId: "pro" | "max";
  billingInterval: "monthly" | "annual";
  currency: BillingCurrency;
  accountSelected: boolean;
  report: PromotionDiagnosticsReport;
};

type Props = {
  promotions: BillingPromotionConfig[];
};

const STATUS_STYLES: Record<
  DiagnosticStatus | "ready" | "blocked" | "warning",
  { label: string; className: string }
> = {
  pass: { label: "Pass", className: "text-emerald-300" },
  ready: { label: "Ready", className: "text-emerald-300" },
  fail: { label: "Fail", className: "text-red-300" },
  blocked: { label: "Blocked", className: "text-red-300" },
  warn: { label: "Warning", className: "text-amber-300" },
  warning: { label: "Warning", className: "text-amber-300" },
  not_checked: { label: "Not checked", className: "text-zinc-400" },
};

const StatusIcon = ({ status }: { status: DiagnosticStatus }) => {
  if (status === "pass") {
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />;
  }
  if (status === "fail") {
    return <XCircle className="h-4 w-4 shrink-0 text-red-400" aria-hidden />;
  }
  if (status === "warn") {
    return <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />;
  }
  return <MinusCircle className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />;
};

const humanise = (value: string) =>
  value.replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase());

const CheckList = ({ checks }: { checks: DiagnosticCheck[] }) => (
  <ul className="flex flex-col gap-1.5">
    {checks.map((item) => (
      <li
        key={`${item.id}:${item.reason || ""}`}
        className="flex items-start gap-2 text-sm text-zinc-300"
        data-testid={`promotion-diagnostics-check-${item.id}`}
        data-status={item.status}
      >
        <StatusIcon status={item.status} />
        <span className="min-w-0">
          <span className="font-bold text-white">{humanise(item.id)}</span>
          <span className="text-zinc-500"> — {STATUS_STYLES[item.status].label}</span>
          {item.reason ? (
            <code className="ml-2 break-all rounded bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-400">
              {item.reason}
            </code>
          ) : null}
        </span>
      </li>
    ))}
  </ul>
);

const Section = ({
  title,
  status,
  description,
  children,
  testId,
}: {
  title: string;
  status: DiagnosticStatus;
  description?: string;
  children: React.ReactNode;
  testId: string;
}) => (
  <section
    className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4"
    data-testid={testId}
    data-status={status}
  >
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <h4 className="text-sm font-black text-white">{title}</h4>
      <span className={`text-xs font-bold ${STATUS_STYLES[status].className}`}>
        {STATUS_STYLES[status].label}
      </span>
    </div>
    {description ? (
      <p className="mb-3 text-xs text-zinc-500">{description}</p>
    ) : null}
    {children}
  </section>
);

/**
 * A Stripe object id is an operator's fact, not a customer's, and it is still
 * an identifier for an object that can be charged against. Shown only when
 * asked for, and never auto-selected into a screenshot.
 */
const MaskedId = ({ label, value }: { label: string; value: string | null }) => {
  const [revealed, setRevealed] = useState(false);
  if (!value) {
    return (
      <p className="text-xs text-zinc-500">
        {label}: <span className="text-zinc-400">not stored</span>
      </p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
      <span>{label}:</span>
      <code className="break-all rounded bg-zinc-900 px-1.5 py-0.5 text-zinc-300">
        {revealed ? value : `${value.slice(0, 5)}${"•".repeat(8)}`}
      </code>
      <button
        type="button"
        onClick={() => setRevealed((current) => !current)}
        className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1 font-bold text-zinc-300 hover:bg-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
      >
        {revealed ? (
          <EyeOff className="h-3 w-3" aria-hidden />
        ) : (
          <Eye className="h-3 w-3" aria-hidden />
        )}
        {revealed ? `Hide ${label}` : `Reveal ${label}`}
      </button>
    </p>
  );
};

export function PromotionDiagnosticsPanel({ promotions }: Props) {
  const fieldId = useId();
  const [promotionId, setPromotionId] = useState(promotions[0]?.id || "");
  const [planId, setPlanId] = useState<"pro" | "max">("pro");
  const [billingInterval, setBillingInterval] = useState<"monthly" | "annual">(
    "monthly"
  );
  const [currency, setCurrency] = useState<BillingCurrency>("USD");
  const [userId, setUserId] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DiagnosticsResponse | null>(null);
  // An external store rather than an effect: the catalogue editor may have
  // published before this panel mounted, and a subscription that only heard
  // future events would read a dirty draft as clean until the next keystroke.
  const draftState = useSyncExternalStore(
    subscribeToPromotionDraftState,
    currentPromotionDraftState,
    serverPromotionDraftState
  );
  const resultRef = useRef<HTMLDivElement | null>(null);

  const selectedPromotion = useMemo(
    () => promotions.find((item) => item.id === promotionId) || null,
    [promotionId, promotions]
  );
  const selectionIsDirty = draftState.dirtyPromotionIds.includes(promotionId);

  const run = useCallback(async () => {
    if (!promotionId || selectionIsDirty) return;
    setIsRunning(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/billing/promotions/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          promotionId,
          planId,
          billingInterval,
          currency,
          userId: userId.trim() || null,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        setResult(null);
        setError(
          typeof data?.error === "string"
            ? data.error
            : "Promotion diagnostics could not be completed."
        );
        return;
      }
      setResult(data as DiagnosticsResponse);
      // Move the operator to the answer they asked for, without stealing focus
      // mid-typing on any other control.
      requestAnimationFrame(() => resultRef.current?.focus());
    } catch {
      setResult(null);
      setError("Promotion diagnostics could not be reached.");
    } finally {
      setIsRunning(false);
    }
  }, [billingInterval, currency, planId, promotionId, selectionIsDirty, userId]);

  const copy = useCallback(async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value);
      dispatchAppToast(`${what} copied.`, "success");
    } catch {
      dispatchAppToast(`${what} could not be copied.`, "error");
    }
  }, []);

  const report = result?.report || null;
  const summaryText = report
    ? [
        `Promotion: ${result?.promotion.code}`,
        `Plan: ${result?.planId} ${result?.billingInterval} (${result?.currency})`,
        `Mode: ${result?.accountSelected ? "account-specific" : "configuration-only"}`,
        `Status: ${report.status}`,
        `Reasons: ${report.reasonSlugs.length ? report.reasonSlugs.join(", ") : "none"}`,
        `Actions: ${report.recommendedActions.map((item) => item.id).join(", ")}`,
      ].join("\n")
    : "";

  const dryRunCommand = result
    ? `npm run billing:reconcile-promotion -- --code ${result.promotion.code} --plan ${result.planId} --dry-run --json`
    : "";

  return (
    <section
      className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-950"
      data-testid="promotion-diagnostics-panel"
    >
      <header className="border-b border-zinc-800 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Stethoscope className="h-5 w-5 text-blue-400" aria-hidden />
          <h3 className="text-lg font-black text-white">Promotion diagnostics</h3>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-zinc-400">
          Reads the saved promotion policy, the selected account and the Stripe
          Coupon and Promotion Code behind this code. It creates nothing: no
          account, no Coupon, no Promotion Code, no Checkout Session, and no
          redemption.
        </p>
      </header>

      <div className="grid gap-4 p-5 lg:grid-cols-2 xl:grid-cols-3">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-bold text-zinc-300">Promotion</span>
          <select
            id={`${fieldId}-promotion`}
            data-testid="promotion-diagnostics-promotion"
            value={promotionId}
            onChange={(event) => setPromotionId(event.target.value)}
            className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
          >
            {promotions.length === 0 ? <option value="">No promotions</option> : null}
            {promotions.map((promotion) => (
              <option key={promotion.id} value={promotion.id}>
                {promotion.code}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-bold text-zinc-300">Plan</span>
          <select
            data-testid="promotion-diagnostics-plan"
            value={planId}
            onChange={(event) => setPlanId(event.target.value as "pro" | "max")}
            className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
          >
            <option value="pro">Pro</option>
            <option value="max">Max</option>
          </select>
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-bold text-zinc-300">Billing interval</span>
          <select
            data-testid="promotion-diagnostics-interval"
            value={billingInterval}
            onChange={(event) =>
              setBillingInterval(event.target.value as "monthly" | "annual")
            }
            className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
          >
            <option value="monthly">Monthly</option>
            <option value="annual">Annual</option>
          </select>
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-bold text-zinc-300">Market currency</span>
          <select
            data-testid="promotion-diagnostics-currency"
            value={currency}
            onChange={(event) =>
              setCurrency(event.target.value as BillingCurrency)
            }
            className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
          >
            {BILLING_CURRENCIES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5 text-sm lg:col-span-2">
          <span className="font-bold text-zinc-300">
            Existing account (optional)
          </span>
          <input
            data-testid="promotion-diagnostics-user"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            placeholder="User ID — leave blank for a configuration-only run"
            aria-describedby={`${fieldId}-account-help`}
            className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-white placeholder:text-zinc-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
          />
          <span id={`${fieldId}-account-help`} className="text-xs text-zinc-500">
            An existing account only. Nothing here creates one, and no account is
            required to diagnose the configuration.
          </span>
        </label>
      </div>

      <div className="flex flex-col gap-3 border-t border-zinc-800 p-5">
        {selectionIsDirty ? (
          <p
            data-testid="promotion-diagnostics-dirty-notice"
            className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            Save or discard changes before diagnosing. Diagnostics read the saved
            database configuration, not the unsaved edits in the promotion
            editor.
          </p>
        ) : (
          <p className="text-xs text-zinc-500">
            Diagnostics read the saved database configuration, not unsaved edits
            in the promotion editor.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={run}
            disabled={isRunning || !promotionId || selectionIsDirty}
            data-testid="promotion-diagnostics-run"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRunning ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Stethoscope className="h-4 w-4" aria-hidden />
            )}
            {isRunning ? "Running diagnostics…" : "Run diagnostics"}
          </button>
          {report ? (
            <>
              <button
                type="button"
                onClick={() => copy(summaryText, "Diagnostics summary")}
                data-testid="promotion-diagnostics-copy-summary"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-bold text-zinc-200 hover:bg-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
              >
                <ClipboardCopy className="h-4 w-4" aria-hidden />
                Copy summary
              </button>
              <button
                type="button"
                onClick={() =>
                  copy(JSON.stringify(result, null, 2), "Diagnostics JSON")
                }
                data-testid="promotion-diagnostics-copy-json"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-bold text-zinc-200 hover:bg-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
              >
                <ClipboardCopy className="h-4 w-4" aria-hidden />
                Copy JSON
              </button>
            </>
          ) : null}
        </div>

        {error ? (
          <div
            role="alert"
            data-testid="promotion-diagnostics-error"
            className="flex flex-wrap items-center gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200"
          >
            <span className="min-w-0">{error}</span>
            <button
              type="button"
              onClick={run}
              className="rounded-lg border border-red-400/50 px-2 py-1 text-xs font-bold text-red-100 hover:bg-red-500/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300"
            >
              Retry
            </button>
          </div>
        ) : null}
      </div>

      <div
        ref={resultRef}
        tabIndex={-1}
        aria-live="polite"
        className="min-w-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
      >
        {report && result ? (
          <div className="flex min-w-0 flex-col gap-4 border-t border-zinc-800 p-5">
            <div
              data-testid="promotion-diagnostics-summary"
              data-status={report.status}
              className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4"
            >
              <p className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-zinc-300">Summary</span>
                <span
                  className={`text-sm font-black ${STATUS_STYLES[report.status].className}`}
                >
                  {STATUS_STYLES[report.status].label}
                </span>
              </p>
              <p className="mt-2 text-xs text-zinc-500">
                {report.status === "ready"
                  ? "No blocker was found in the policy and Stripe linkage that can be read from here. This is not a guarantee that Checkout will succeed."
                  : "Blockers below are read from the saved configuration and Stripe. Fix them before retrying a customer checkout."}
              </p>
            </div>

            <Section
              testId="promotion-diagnostics-local-policy"
              title="Local policy"
              status={report.localPolicy.status}
            >
              <CheckList checks={report.localPolicy.checks} />
            </Section>

            <Section
              testId="promotion-diagnostics-account"
              title="Account eligibility"
              status={report.account.status}
              description={
                report.account.evaluated
                  ? "Judged with the same function /api/billing/checkout uses."
                  : "Not evaluated — no account selected."
              }
            >
              <CheckList checks={report.account.checks} />
            </Section>

            <Section
              testId="promotion-diagnostics-stripe"
              title="Stripe linkage"
              status={report.stripe.status}
              description={
                report.stripe.facts
                  ? `Expected mode: ${
                      report.stripe.facts.expectLiveMode === null
                        ? "unknown"
                        : report.stripe.facts.expectLiveMode
                          ? "live"
                          : "test"
                    } · exact-code candidates: ${report.stripe.facts.exactCodeCandidates.length} · recommendation: ${report.stripe.facts.recommendation}`
                  : undefined
              }
            >
              <CheckList checks={report.stripe.checks} />
              {report.stripe.facts ? (
                <div className="mt-3 flex flex-col gap-1">
                  <MaskedId
                    label="Stored coupon"
                    value={report.stripe.facts.storedCouponId}
                  />
                  {report.stripe.facts.storedCouponId ? (
                    <p className="text-xs text-zinc-500">
                      Stored coupon in Stripe:{" "}
                      {report.stripe.facts.storedCouponExists
                        ? "found"
                        : "not found in this mode"}
                    </p>
                  ) : null}
                  <MaskedId
                    label="Stored promotion code"
                    value={report.stripe.facts.storedPromotionCodeId}
                  />
                  {/*
                    The reasons a checkout would be refused, on screen.
                    A check that says `stored_coupon_mismatch` names the object
                    but not the field, and the field is the whole answer: a
                    `duration` mismatch and a `metadata_promotion_id` mismatch
                    call for completely different repairs. Drift was printed
                    here from the start while these were not, which had it
                    exactly backwards.
                  */}
                  {report.stripe.blockingReasons.length > 0 ? (
                    <p
                      className="text-xs text-red-300"
                      data-testid="promotion-diagnostics-blocking-reasons"
                    >
                      Blocking: {report.stripe.blockingReasons.join(", ")}
                    </p>
                  ) : null}
                  {report.stripe.driftReasons.length > 0 ? (
                    <p className="text-xs text-amber-300">
                      Drift (non-fatal): {report.stripe.driftReasons.join(", ")}
                    </p>
                  ) : null}
                  {report.stripe.facts.exactCodeCandidates.length > 0 ? (
                    <div
                      className="mt-1 flex flex-col gap-1"
                      data-testid="promotion-diagnostics-candidates"
                    >
                      <p className="text-xs font-bold text-zinc-400">
                        Stripe objects holding this code string
                      </p>
                      {report.stripe.facts.exactCodeCandidates.map(
                        (candidate) => (
                          <div key={candidate.id} className="flex flex-col gap-1">
                            <MaskedId
                              label={`${candidate.active ? "Active" : "Inactive"}${
                                candidate.adoptable ? ", adoptable" : ""
                              }`}
                              value={candidate.id}
                            />
                            {candidate.mismatches.length > 0 ? (
                              <p className="pl-1 text-xs text-zinc-500">
                                {candidate.mismatches.join(", ")}
                              </p>
                            ) : null}
                          </div>
                        )
                      )}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </Section>

            <Section
              testId="promotion-diagnostics-preview"
              title="Checkout request preview"
              status={
                report.checkoutPreview.bothDiscountParamsSent ? "fail" : "pass"
              }
              description="Predicted from the resolved configuration. No Checkout Session is created."
            >
              <div className="min-w-0 overflow-x-auto">
                <table className="w-full min-w-[26rem] text-left text-sm text-zinc-300">
                  <tbody>
                    <tr>
                      <th scope="row" className="py-1 pr-4 font-bold text-zinc-400">
                        Base amount
                      </th>
                      <td className="py-1">
                        {report.checkoutPreview.baseAmountMinor}{" "}
                        {report.checkoutPreview.currency} (minor units)
                      </td>
                    </tr>
                    <tr>
                      <th scope="row" className="py-1 pr-4 font-bold text-zinc-400">
                        Discounted amount
                      </th>
                      <td className="py-1" data-testid="promotion-diagnostics-discounted">
                        {report.checkoutPreview.discountedAmountMinor}{" "}
                        {report.checkoutPreview.currency} (minor units)
                      </td>
                    </tr>
                    <tr>
                      <th scope="row" className="py-1 pr-4 font-bold text-zinc-400">
                        Discount source
                      </th>
                      <td className="py-1">
                        {report.checkoutPreview.expectedDiscountSource}
                      </td>
                    </tr>
                    <tr>
                      <th scope="row" className="py-1 pr-4 font-bold text-zinc-400">
                        <code>discounts</code> sent
                      </th>
                      <td className="py-1">
                        {report.checkoutPreview.discountsParamSent ? "yes" : "no"}
                      </td>
                    </tr>
                    <tr>
                      <th scope="row" className="py-1 pr-4 font-bold text-zinc-400">
                        <code>allow_promotion_codes</code>
                      </th>
                      <td
                        className="py-1"
                        data-testid="promotion-diagnostics-allow-promotion-codes"
                      >
                        {report.checkoutPreview.allowPromotionCodesParam}
                      </td>
                    </tr>
                    <tr>
                      <th scope="row" className="py-1 pr-4 font-bold text-zinc-400">
                        Payment method required
                      </th>
                      <td className="py-1">
                        {report.checkoutPreview.paymentMethodRequired ? "yes" : "no"}
                      </td>
                    </tr>
                    <tr>
                      <th scope="row" className="py-1 pr-4 font-bold text-zinc-400">
                        Automatic renewal
                      </th>
                      <td className="py-1">
                        {report.checkoutPreview.automaticRenewal ? "yes" : "no"}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {report.checkoutPreview.bothDiscountParamsSent ? (
                <p className="mt-2 text-sm text-red-300">
                  Blocker: the Session request would carry both{" "}
                  <code>discounts</code> and <code>allow_promotion_codes</code>.
                  Stripe refuses that request whatever the value is.
                </p>
              ) : null}
            </Section>

            <Section
              testId="promotion-diagnostics-abuse"
              title="Abuse signals"
              status="not_checked"
              description="Not evaluated — the admin request's IP is not the customer's IP, and evaluating it here would corrupt the shared-IP signal."
            >
              <p className="text-sm text-zinc-300">
                Stored signals on this promotion: {report.abuseSignals.storedRiskSignals.total} total ·{" "}
                {report.abuseSignals.storedRiskSignals.sharedIp} shared IP ·{" "}
                {report.abuseSignals.storedRiskSignals.sharedPaymentMethod} shared
                payment method.
              </p>
            </Section>

            <Section
              testId="promotion-diagnostics-actions"
              title="Recommended action"
              status={
                report.recommendedActions.some(
                  (item) => item.severity === "blocker"
                )
                  ? "fail"
                  : report.recommendedActions.some(
                        (item) => item.severity === "warning"
                      )
                    ? "warn"
                    : "pass"
              }
            >
              <ul className="flex flex-col gap-1.5 text-sm text-zinc-300">
                {report.recommendedActions.map((action) => (
                  <li key={action.id} data-testid={`promotion-diagnostics-action-${action.id}`}>
                    <span className="font-bold text-white">
                      {humanise(action.id)}
                    </span>
                    <span className="text-zinc-500"> — {action.severity}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <code className="min-w-0 break-all rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-400">
                  {dryRunCommand}
                </code>
                <button
                  type="button"
                  onClick={() => copy(dryRunCommand, "Dry-run command")}
                  className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1 text-xs font-bold text-zinc-200 hover:bg-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
                >
                  <ClipboardCopy className="h-3 w-3" aria-hidden />
                  Copy dry-run command
                </button>
              </div>
              <p className="mt-2 text-xs text-zinc-500">
                Repairs are run deliberately from a terminal with an incident
                reference. This console never applies one, and never deletes or
                deactivates a Stripe object.
              </p>
            </Section>

            {selectedPromotion &&
            selectedPromotion.appliesToPlanIds.length > 1 ? (
              <p className="text-xs text-zinc-500">
                This promotion is eligible for{" "}
                {selectedPromotion.appliesToPlanIds.join(" and ")}. One promotion
                row carries one Stripe Coupon and Promotion Code for every
                eligible plan, because a Stripe promotion code string is unique
                across the account.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
