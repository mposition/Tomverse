"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  CircleDollarSign,
  CreditCard,
  ExternalLink,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { ModelLogo } from "@/components/chat/ModelLogo";
import type { AiProvider } from "@/lib/models";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import type {
  ProviderHealthDashboard,
  ProviderHealthRow,
  ProviderHealthStatus,
} from "@/lib/providerMonitoring";
import type {
  ProviderPricingModel,
  ProviderSettlementModel,
} from "@/lib/providerBillingTypes";
import type { PublicProviderStatus } from "@/lib/providerPublicStatusCore";
import {
  LIVE_VERIFICATION_KIND,
  canOfferRecovery,
  evaluateRecoveryEligibility,
} from "@/lib/providerRecoveryCore";

const REFRESH_INTERVAL_MS = 120_000;

const providerConsoleHref: Record<AiProvider, string> = {
  openai: "https://platform.openai.com/settings/organization/billing/overview",
  anthropic: "https://platform.claude.com/dashboard",
  google:
    "https://aistudio.google.com/billing?billing=0126EA-F8BC8E-ED63F7&project=gen-lang-client-0902272053",
  groq: "https://console.groq.com/settings/organization/usage",
  xai: "https://console.x.ai/team/efce823d-10a4-4ac4-a8ae-844b6f4c0f66",
  deepseek: "https://platform.deepseek.com/usage",
  mistral: "https://admin.mistral.ai/organization/usage",
  moonshot: "https://platform.kimi.ai/console/account",
  qwen: "https://billing-cost.console.alibabacloud.com/finance/month-bill/account",
  zhipu: "https://z.ai/manage-apikey/billing",
  perplexity:
    "https://console.perplexity.ai/group/36f95894-ee38-4751-b4a0-4365e41a3c31/billing",
};

const money = (microUsd: number) =>
  `${microUsd < 0 ? "-" : ""}$${Math.abs(microUsd / 1_000_000).toFixed(2)}`;
const optionalMoney = (microUsd: number | null) =>
  microUsd === null ? "Not synced" : money(microUsd);
const balanceMoney = (amount: number, currency: string) => {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 4,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(4)}`;
  }
};
const dateLabel = (value: string | null, fallback = "No success yet") => {
  if (!value) return fallback;
  return new Date(value).toISOString().replace("T", " ").slice(0, 16);
};
const statusCopy: Record<ProviderHealthStatus, string> = {
  available: "Available",
  limited: "Limited",
  outage: "Outage",
};
const statusClass: Record<ProviderHealthStatus, string> = {
  available: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  limited: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  outage: "border-red-500/30 bg-red-500/10 text-red-300",
};
const statusPanelClass: Record<ProviderHealthStatus, string> = {
  available: "border-emerald-500/20 bg-emerald-500/5",
  limited: "border-amber-500/25 bg-amber-500/5",
  outage: "border-red-500/25 bg-red-500/5",
};
// What tomverse.app/status shows for this provider right now -- rendered
// here too so admins can see the public claim can't have drifted from this
// panel's own diagnostics (both read provider.publicStatus off the same
// dashboard row; see lib/providerPublicStatusCore.ts).
const publicStatusCopy: Record<PublicProviderStatus, string> = {
  operational: "Public: Operational",
  degraded: "Public: Degraded",
  incident: "Public: Incident",
  unknown: "Public: Unknown",
};
const publicStatusClass: Record<PublicProviderStatus, string> = {
  operational: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  degraded: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  incident: "border-red-500/30 bg-red-500/10 text-red-300",
  unknown: "border-zinc-600/40 bg-zinc-700/20 text-zinc-300",
};
const balanceSourceCopy: Record<ProviderHealthRow["balanceSource"], string> = {
  api: "provider API",
  db_estimate: "DB estimate",
  env_manual: "environment value",
  unavailable: "not configured",
};
const pricingModelCopy: Record<ProviderPricingModel, string> = {
  usage_based: "Usage-based",
  subscription: "Subscription",
  committed_capacity: "Committed capacity",
  unknown: "Unverified pricing",
};
const settlementModelCopy: Record<ProviderSettlementModel, string> = {
  prepaid: "Prepaid",
  postpaid: "Postpaid",
  hybrid: "Hybrid",
  invoice: "Invoice",
  unknown: "Unverified settlement",
};
const billingSourceCopy: Record<ProviderHealthRow["billingProfile"]["source"], string> = {
  provider_api: "Provider API",
  admin_verified: "Admin verified",
  documented_default: "Documented default",
};
const creditAlertClass = (level: ProviderHealthRow["creditAlertLevel"]) => {
  if (level === "5") return "text-red-300";
  if (level === "20") return "text-amber-300";
  if (level === "50") return "text-sky-300";
  return "text-emerald-300";
};
const apiKeyClass = (configured: boolean) =>
  configured
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : "border-zinc-700 bg-zinc-900 text-zinc-400";

// STG-R002: administrator-triggered live verification and verified recovery.
// The two are separate actions on purpose. Verification is evidence; clearing
// a provider's failure block is a state change that requires that evidence.
// Recovery never writes lastSuccessAt -- it stops expired failures from
// counting as current, it does not invent a success that never happened.
type ProviderVerificationCheck = {
  id: string;
  status: string;
  modelId: string | null;
  latencyMs: number | null;
  diagnosticCode: string | null;
  errorCode: string | null;
  message: string | null;
  createdAt: string;
  createdByEmail: string | null;
  recoveryApplied: boolean;
};

type ProviderVerificationSummary = {
  provider: string;
  lastCheck: ProviderVerificationCheck | null;
  recentRecoveries: Array<{
    id: string;
    modelId: string | null;
    previousConsecutiveFailures: number | null;
    recoveryAppliedAt: string | null;
    createdByEmail: string | null;
  }>;
};

type RunVerification = (provider: AiProvider) => Promise<boolean>;
type RunRecovery = (provider: AiProvider, checkId: string) => Promise<boolean>;

const verificationStatusCopy: Record<string, string> = {
  success: "Verification succeeded",
  failed: "Verification failed",
  unavailable: "Verification unavailable",
  running: "Verification in progress",
};
const verificationStatusClass: Record<string, string> = {
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  failed: "border-red-500/30 bg-red-500/10 text-red-300",
  unavailable: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  running: "border-zinc-600/40 bg-zinc-700/20 text-zinc-300",
};

type SaveCredit = (
  provider: AiProvider,
  creditUsd: number,
  note: string
) => Promise<boolean>;

type SaveBilling = (
  provider: AiProvider,
  profile: {
    pricingModel: ProviderPricingModel;
    settlementModel: ProviderSettlementModel;
    currency: string;
    monthlyLimitUsd: number | null;
    note: string;
  }
) => Promise<boolean>;

function ProviderVerificationSection({
  provider,
  summary,
  canRunVerification,
  verifying,
  recovering,
  evaluatedAt,
  onVerify,
  onRecover,
}: {
  provider: ProviderHealthRow;
  summary: ProviderVerificationSummary | null;
  canRunVerification: boolean;
  verifying: boolean;
  recovering: boolean;
  /** When the dashboard this row was built from was read. */
  evaluatedAt: string;
  onVerify: RunVerification;
  onRecover: RunRecovery;
}) {
  const [confirmingVerification, setConfirmingVerification] = useState(false);
  const lastCheck = summary?.lastCheck ?? null;
  const busy = verifying || recovering;
  const canVerify = canRunVerification && Boolean(provider.verificationModelId);

  // The same rules the API re-applies inside its transaction. Mirrored here so
  // the control's enabled state matches the server's answer -- but the button
  // is a courtesy, never the control: /api/admin/provider-health/recover
  // re-reads the evidence and decides for itself.
  //
  // `now` is the dashboard's read time, not `new Date()`. This component is
  // rendered on the server as well as in the browser, and a clock read during
  // render gives the two renders different answers -- which React reports as a
  // hydration mismatch and recovers from by re-rendering the tree on the
  // client. The dashboard's own timestamp is the same value in both places,
  // and it is also the instant the evidence below was actually read.
  const eligibility = evaluateRecoveryEligibility({
    now: new Date(evaluatedAt),
    provider: provider.provider,
    evidence: lastCheck
      ? {
          provider: provider.provider,
          kind: LIVE_VERIFICATION_KIND,
          status: lastCheck.status,
          createdAt: new Date(lastCheck.createdAt),
          recoveryApplied: lastCheck.recoveryApplied,
        }
      : null,
    consecutiveFailures: provider.consecutiveFailures,
  });
  const canRecover =
    canRunVerification &&
    canOfferRecovery({
      publicStatus: provider.publicStatus,
      consecutiveFailures: provider.consecutiveFailures,
      eligibility,
    });
  const recoveryBlockedReason = eligibility.allowed ? null : eligibility.detail;

  return (
    // Scoped test id: the real console renders one of these per provider, so
    // copy assertions need a container to resolve against rather than matching
    // the same sentence in eleven rows.
    <div
      data-testid={`provider-verification-${provider.provider}`}
      className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <PanelLabel>Verification and recovery</PanelLabel>
          <p className="mt-2 text-xs leading-5 text-zinc-500">
            Sends one minimal request to{" "}
            <span className="font-mono text-zinc-400">
              {provider.verificationModelId || "no eligible model"}
            </span>
            . This call is billed by the provider. It never creates a
            conversation, a message, or a credit ledger entry, and never charges
            a customer.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid={`provider-verify-${provider.provider}`}
            onClick={() => {
              if (busy || !canVerify) return;
              setConfirmingVerification(true);
            }}
            disabled={busy || !canVerify || confirmingVerification}
            aria-describedby={`provider-verification-note-${provider.provider}`}
            className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-200 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            {verifying ? "Running verification" : "Run verification"}
          </button>
          <button
            type="button"
            data-testid={`provider-recover-${provider.provider}`}
            onClick={() => {
              if (busy || !canRecover || !lastCheck) return;
              void onRecover(provider.provider, lastCheck.id);
            }}
            disabled={busy || !canRecover || !lastCheck}
            title={recoveryBlockedReason || undefined}
            className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 text-xs font-bold text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:bg-zinc-900 disabled:text-zinc-500"
          >
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            {recovering ? "Recovering" : "Recover provider status"}
          </button>
        </div>
      </div>

      {!canRunVerification ? (
        <p className="mt-3 text-xs text-zinc-500">
          Running a verification requires the ops or owner admin role.
        </p>
      ) : null}
      {canRunVerification && !provider.verificationModelId ? (
        <p className="mt-3 text-xs text-amber-300">
          No enabled model is available to verify this provider with.
        </p>
      ) : null}

      {confirmingVerification ? (
        <div
          role="alertdialog"
          aria-label={`Confirm a live verification call to ${provider.displayName}`}
          className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-3"
        >
          <p className="text-xs font-semibold text-amber-100">
            This sends a real, billed request to {provider.displayName}.
          </p>
          <p className="mt-1 text-xs leading-5 text-amber-100/80">
            One call to {provider.verificationModelId} with a minimal token
            budget. A further verification for this provider is refused until
            the cooldown elapses.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid={`provider-verify-confirm-${provider.provider}`}
              onClick={() => {
                if (busy) return;
                setConfirmingVerification(false);
                void onVerify(provider.provider);
              }}
              disabled={busy}
              className="inline-flex h-8 cursor-pointer items-center rounded-lg border border-amber-500/40 bg-amber-500/20 px-3 text-xs font-bold text-amber-100 transition hover:bg-amber-500/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Confirm and run
            </button>
            <button
              type="button"
              onClick={() => setConfirmingVerification(false)}
              className="inline-flex h-8 cursor-pointer items-center rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-300 transition hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div
        id={`provider-verification-note-${provider.provider}`}
        className="mt-3"
        aria-live="polite"
      >
        {lastCheck ? (
          <div
            data-testid={`provider-verification-result-${provider.provider}`}
            className={`rounded-xl border px-3 py-2.5 ${
              verificationStatusClass[lastCheck.status] ||
              verificationStatusClass.running
            }`}
          >
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
              <span>
                {verificationStatusCopy[lastCheck.status] ||
                  `Verification ${lastCheck.status}`}
              </span>
              <span className="text-[11px] font-normal opacity-80">
                {dateLabel(lastCheck.createdAt, "Never run")}
              </span>
              {lastCheck.latencyMs !== null ? (
                <span className="text-[11px] font-normal opacity-80">
                  {lastCheck.latencyMs} ms
                </span>
              ) : null}
              {lastCheck.modelId ? (
                <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-[10px] opacity-90">
                  {lastCheck.modelId}
                </code>
              ) : null}
              {lastCheck.recoveryApplied ? (
                <span className="rounded-full bg-black/30 px-2 py-0.5 text-[10px] font-normal">
                  Already used for a recovery
                </span>
              ) : null}
            </div>
            {lastCheck.diagnosticCode ? (
              <p className="mt-1.5 break-all font-mono text-[10px] opacity-80">
                {lastCheck.diagnosticCode}
                {lastCheck.errorCode ? ` / ${lastCheck.errorCode}` : ""}
              </p>
            ) : null}
            {lastCheck.message ? (
              <p className="mt-1.5 break-words text-xs leading-5 opacity-90">
                {lastCheck.message}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-zinc-500">
            No live verification has been run for this provider yet.
          </p>
        )}
      </div>

      {recoveryBlockedReason && provider.consecutiveFailures > 0 ? (
        <p className="mt-2 text-xs leading-5 text-zinc-500">
          {recoveryBlockedReason}
        </p>
      ) : null}

      {summary && summary.recentRecoveries.length > 0 ? (
        <div className="mt-3">
          <PanelLabel>Recovery history</PanelLabel>
          <ul className="mt-2 space-y-1.5">
            {summary.recentRecoveries.map((recovery) => (
              <li
                key={recovery.id}
                className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-[11px] leading-5 text-zinc-400"
              >
                {dateLabel(recovery.recoveryAppliedAt, "Unknown time")} · cleared{" "}
                {recovery.previousConsecutiveFailures ?? 0} consecutive failures
                {recovery.createdByEmail ? ` · ${recovery.createdByEmail}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ProviderRow({
  provider,
  canManageCredits,
  canRunVerification,
  verificationSummary,
  verifying,
  recovering,
  savingCredit,
  savingBilling,
  evaluatedAt,
  onSaveCredit,
  onSaveBilling,
  onVerify,
  onRecover,
}: {
  provider: ProviderHealthRow;
  canManageCredits: boolean;
  canRunVerification: boolean;
  verificationSummary: ProviderVerificationSummary | null;
  verifying: boolean;
  recovering: boolean;
  savingCredit: boolean;
  savingBilling: boolean;
  evaluatedAt: string;
  onSaveCredit: SaveCredit;
  onSaveBilling: SaveBilling;
  onVerify: RunVerification;
  onRecover: RunRecovery;
}) {
  const { getEnabledModel } = useModelCatalog();
  const [statusOpen, setStatusOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [creditEditorOpen, setCreditEditorOpen] = useState(false);
  const [billingEditorOpen, setBillingEditorOpen] = useState(false);
  const [selectedErrorCode, setSelectedErrorCode] = useState<string | null>(null);
  const [creditUsd, setCreditUsd] = useState(
    provider.credit.configuredCreditMicroUsd === null
      ? ""
      : (provider.credit.configuredCreditMicroUsd / 1_000_000).toFixed(2)
  );
  const [creditNote, setCreditNote] = useState(provider.credit.note || "");
  const [pricingModel, setPricingModel] = useState<ProviderPricingModel>(
    provider.billingProfile.pricingModel
  );
  const [settlementModel, setSettlementModel] = useState<ProviderSettlementModel>(
    provider.billingProfile.settlementModel
  );
  const [billingCurrency, setBillingCurrency] = useState(
    provider.billingProfile.currency
  );
  const [monthlyLimitUsd, setMonthlyLimitUsd] = useState(
    provider.billingProfile.monthlyLimitMicroUsd === null
      ? ""
      : (provider.billingProfile.monthlyLimitMicroUsd / 1_000_000).toFixed(2)
  );
  const [billingNote, setBillingNote] = useState(provider.billingProfile.note || "");
  const fallbackModels = provider.fallback.recommendedModelIds
    .map((id) => getEnabledModel(id))
    .filter((model): model is NonNullable<typeof model> => Boolean(model))
    .map((model) => model.name);
  const varianceLabel =
    provider.usageVariancePercent === null
      ? "No reconciliation yet"
      : `${provider.usageVariancePercent > 0 ? "+" : ""}${provider.usageVariancePercent}%`;
  const statusDetailsId = `provider-status-${provider.provider}`;
  const parsedCreditUsd = Number(creditUsd);
  const creditIsValid =
    creditUsd.trim().length > 0 &&
    Number.isFinite(parsedCreditUsd) &&
    parsedCreditUsd >= 0 &&
    parsedCreditUsd <= 1_000_000;
  const estimatedBalance = provider.credit.estimatedBalanceMicroUsd;
  const tracksCredit =
    provider.provider === "zhipu" ||
    provider.billingProfile.settlementModel === "prepaid" ||
    provider.billingProfile.settlementModel === "hybrid";
  const compactBalance = tracksCredit
    ? provider.balanceAmount !== null
      ? balanceMoney(provider.balanceAmount, provider.balanceCurrency)
      : estimatedBalance !== null
        ? money(estimatedBalance)
        : "Not available"
    : money(provider.internalBudgetHeadroomMicroUsd);
  const billingBasisMicroUsd =
    provider.providerReportedMonthCostMicroUsd ?? provider.monthCostMicroUsd;
  const providerBillingLimitMicroUsd = provider.billingProfile.monthlyLimitMicroUsd;
  const internalBudgetVariableName =
    `CHAT_PROVIDER_${provider.provider.toUpperCase()}_COST_MICROUSD_PER_MONTH`;
  const internalBudgetSourceDetail =
    provider.internalBudgetSource === "railway_environment"
      ? `Railway ${internalBudgetVariableName}`
      : `Code default · ${internalBudgetVariableName} absent or invalid`;
  const limitDifferenceMicroUsd =
    providerBillingLimitMicroUsd === null
      ? null
      : Math.abs(providerBillingLimitMicroUsd - provider.monthBudgetMicroUsd);
  const limitAlignmentCopy =
    provider.limitAlignment === "provider_not_configured"
      ? "No provider billing limit is recorded in DB. The Tomverse cap is the only known operational ceiling."
      : provider.limitAlignment === "provider_lower"
        ? `The provider billing limit is ${money(limitDifferenceMicroUsd!)} lower. The provider may stop service before Tomverse reaches its cap.`
        : provider.limitAlignment === "tomverse_lower"
          ? `The Tomverse enforced cap is ${money(limitDifferenceMicroUsd!)} lower, so Tomverse blocks new usage first.`
          : "The provider billing limit and Tomverse enforced cap are aligned.";
  const limitAlignmentClass =
    provider.limitAlignment === "provider_lower"
      ? "border-amber-500/25 bg-amber-500/5 text-amber-100/80"
      : provider.limitAlignment === "aligned"
        ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-100/80"
        : "border-blue-500/20 bg-blue-500/5 text-blue-100/80";
  const parsedMonthlyLimitUsd = Number(monthlyLimitUsd);
  const monthlyLimitIsValid =
    monthlyLimitUsd.trim() === "" ||
    (Number.isFinite(parsedMonthlyLimitUsd) &&
      parsedMonthlyLimitUsd >= 0 &&
      parsedMonthlyLimitUsd <= 1_000_000);
  const selectedError = provider.recentErrors.find(
    (error) => error.code === selectedErrorCode
  );
  const selectedErrorEvents = selectedError
    ? provider.recentErrorEvents.filter(
        (event) => event.diagnosticCode === selectedError.code
      )
    : [];

  const toggleCreditEditor = () => {
    if (!creditEditorOpen) {
      setCreditUsd(
        provider.credit.configuredCreditMicroUsd === null
          ? ""
          : (provider.credit.configuredCreditMicroUsd / 1_000_000).toFixed(2)
      );
      setCreditNote(provider.credit.note || "");
    }
    setCreditEditorOpen((open) => !open);
  };

  const submitCredit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!creditIsValid || savingCredit) return;
    const saved = await onSaveCredit(
      provider.provider,
      parsedCreditUsd,
      creditNote
    );
    if (saved) setCreditEditorOpen(false);
  };

  const toggleBillingEditor = () => {
    if (!billingEditorOpen) {
      setPricingModel(provider.billingProfile.pricingModel);
      setSettlementModel(provider.billingProfile.settlementModel);
      setBillingCurrency(provider.billingProfile.currency);
      setMonthlyLimitUsd(
        provider.billingProfile.monthlyLimitMicroUsd === null
          ? ""
          : (provider.billingProfile.monthlyLimitMicroUsd / 1_000_000).toFixed(2)
      );
      setBillingNote(provider.billingProfile.note || "");
    }
    setBillingEditorOpen((open) => !open);
  };

  const submitBilling = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!monthlyLimitIsValid || savingBilling) return;
    const saved = await onSaveBilling(provider.provider, {
      pricingModel,
      settlementModel,
      currency: billingCurrency,
      monthlyLimitUsd:
        monthlyLimitUsd.trim() === "" ? null : parsedMonthlyLimitUsd,
      note: billingNote,
    });
    if (saved) setBillingEditorOpen(false);
  };

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-4">
          <ModelLogo provider={provider.provider} size="lg" className="ring-zinc-800" />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-white">
                <a
                  href={providerConsoleHref[provider.provider]}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-sm underline-offset-4 transition hover:text-blue-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                  aria-label={`Open ${provider.displayName} provider console in a new tab`}
                  title={`Open ${provider.displayName} provider console`}
                >
                  {provider.displayName}
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              </h2>
              <Link
                href={`/admin/providers/${provider.provider}`}
                className="rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs font-bold text-zinc-300 transition hover:border-blue-500/40 hover:text-blue-200"
              >
                Workspace
              </Link>
              <button
                type="button"
                onClick={() => setStatusOpen((open) => !open)}
                aria-expanded={statusOpen}
                aria-controls={statusDetailsId}
                title="Show the status decision details"
                className={`inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold transition hover:brightness-125 ${statusClass[provider.status]}`}
              >
                {statusCopy[provider.status]}
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${statusOpen ? "rotate-180" : ""}`}
                />
              </button>
              <span
                title={provider.publicStatusReasonText}
                className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${publicStatusClass[provider.publicStatus]}`}
              >
                {publicStatusCopy[provider.publicStatus]}
              </span>
              <span
                className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${apiKeyClass(provider.apiKeyConfigured)}`}
              >
                {provider.apiKeyConfigured ? "API key set" : "API key missing"}
              </span>
              <span className="rounded-full border border-blue-500/25 bg-blue-500/10 px-2.5 py-1 text-xs font-semibold text-blue-200">
                {pricingModelCopy[provider.billingProfile.pricingModel]} ·{" "}
                {settlementModelCopy[provider.billingProfile.settlementModel]}
              </span>
            </div>
            <p className="mt-2 text-sm text-zinc-400">
              Last good response: {dateLabel(provider.lastSuccessAt)}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-3 lg:min-w-[600px]">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Metric label="Today usage" value={money(provider.todayCostMicroUsd)} />
            <Metric
              label={tracksCredit ? "Estimated balance" : "Budget headroom"}
              value={compactBalance}
              valueClass={
                tracksCredit
                  ? creditAlertClass(provider.creditAlertLevel)
                  : provider.internalBudgetHeadroomMicroUsd < 0
                    ? "text-red-300"
                    : "text-emerald-300"
              }
            />
            <Metric label="Month usage" value={money(billingBasisMicroUsd)} />
            <Metric
              label="Recent error"
              value={provider.recentErrorCode || "None"}
              valueClass={provider.recentErrorCode ? "text-amber-300" : "text-emerald-300"}
            />
          </div>
          <button
            type="button"
            onClick={() => setDetailsOpen((open) => !open)}
            aria-expanded={detailsOpen}
            className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 self-end rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-200 transition hover:bg-zinc-800"
          >
            {detailsOpen ? "Hide details" : "Details"}
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${detailsOpen ? "rotate-180" : ""}`}
            />
          </button>
        </div>
      </div>

      {statusOpen && (
        <div
          id={statusDetailsId}
          className={`mt-4 rounded-2xl border p-4 ${statusPanelClass[provider.status]}`}
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-zinc-300" />
            <h3 className="text-sm font-bold text-white">
              Why {provider.displayName} is {statusCopy[provider.status]}
            </h3>
          </div>
          <div className="mt-3 grid gap-2">
            {provider.statusReasons.map((reason) => (
              <div
                key={reason.code}
                className="rounded-xl border border-white/10 bg-black/20 px-3 py-2.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-zinc-100">
                    {reason.title}
                  </span>
                  <code className="rounded bg-black/30 px-1.5 py-0.5 text-[10px] text-zinc-400">
                    {reason.code}
                  </code>
                </div>
                <p className="mt-1 text-xs leading-5 text-zinc-400">
                  {reason.detail}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-5 text-zinc-500">
            Policy: the recent {provider.healthWindowMinutes}-minute window needs at
            least 5 calls, 3 failures, and a 50% failure rate before a provider is
            Limited. Five failures at an 80% rate indicate Outage. Three consecutive
            successes restore Available status. Empty model output remains a model-level
            diagnostic. Monthly budget warnings still apply at 80% and 100%.
          </p>
        </div>
      )}

      <ProviderVerificationSection
        provider={provider}
        summary={verificationSummary}
        canRunVerification={canRunVerification}
        verifying={verifying}
        recovering={recovering}
        evaluatedAt={evaluatedAt}
        onVerify={onVerify}
        onRecover={onRecover}
      />

      {detailsOpen && (
        <>
      <div className="mt-5 grid gap-4 border-t border-zinc-800 pt-5 lg:grid-cols-3">
        <div>
          <PanelLabel>Usage / Cost</PanelLabel>
          <p className="mt-2 text-sm font-semibold text-zinc-200">
            Today internal (UTC) {money(provider.todayCostMicroUsd)}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Month internal {money(provider.monthCostMicroUsd)} of{" "}
            {money(provider.monthBudgetMicroUsd)}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            {provider.provider === "mistral"
              ? "Provider reconciliation: Unavailable on current Mistral plan"
              : `Provider reported net cost ${optionalMoney(provider.providerReportedMonthCostMicroUsd)}`}
          </p>
          <p className="mt-1 text-xs text-zinc-500">Variance {varianceLabel}</p>
          <p className="mt-1 text-xs text-zinc-500">
            Usage source: {provider.provider === "mistral" ? "Internal response accounting" : provider.usageSource}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            {provider.provider === "mistral"
              ? "Monthly verification: Compare manually with the Mistral Usage dashboard"
              : `Last usage sync ${dateLabel(provider.lastUsageSyncAt)}`}
          </p>
        </div>
        <div>
          <PanelLabel>Alerts</PanelLabel>
          <p className="mt-2 text-sm text-zinc-300">
            Alert threshold:{" "}
            {provider.alertLevel === "none"
              ? "below 50%"
              : `${provider.alertLevel}% reached`}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Failure surge status is based on recent provider errors.
          </p>
        </div>
        <div>
          <PanelLabel>Fallback Policy</PanelLabel>
          <p className="mt-2 text-sm text-zinc-300">{provider.fallback.reason}</p>
          <p className="mt-1 text-xs text-zinc-500">
            {fallbackModels.join(" / ") || "No fallback model configured"}
          </p>
        </div>
      </div>

      <div className="mt-5 border-t border-zinc-800 pt-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <CreditCard className="mt-0.5 h-5 w-5 text-blue-300" />
            <div>
              <PanelLabel>Billing model</PanelLabel>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                {pricingModelCopy[provider.billingProfile.pricingModel]} ·{" "}
                {settlementModelCopy[provider.billingProfile.settlementModel]} ·{" "}
                {billingSourceCopy[provider.billingProfile.source]}
                {provider.billingProfile.verifiedAt
                  ? ` · Verified ${dateLabel(provider.billingProfile.verifiedAt)}`
                  : " · Verify against your account contract"}
              </p>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                Provider billing limit is a DB-recorded account/contract reference.
                Tomverse enforced cap is the application limit used to block new usage.
              </p>
            </div>
          </div>
          {canManageCredits && (
            <button
              type="button"
              onClick={toggleBillingEditor}
              className="inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-200 transition hover:bg-zinc-800"
            >
              <Settings2 className="h-3.5 w-3.5" />
              {billingEditorOpen ? "Close profile" : "Edit profile"}
            </button>
          )}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {tracksCredit && (
            <Metric
              label={provider.billingProfile.settlementModel === "hybrid" ? "Optional credit" : "Estimated balance"}
              value={
                provider.balanceAmount === null
                  ? provider.billingProfile.settlementModel === "hybrid"
                    ? "Not synced (optional)"
                    : "Not configured"
                  : balanceMoney(
                      provider.balanceAmount,
                      provider.balanceCurrency
                    )
              }
              detail={
                provider.balanceAmount === null
                  ? undefined
                  : [
                      balanceSourceCopy[provider.balanceSource],
                      provider.balanceAvailable === null
                        ? null
                        : provider.balanceAvailable
                          ? "available"
                          : "unavailable",
                      provider.balanceGrantedAmount === null
                        ? null
                        : `granted ${balanceMoney(
                            provider.balanceGrantedAmount,
                            provider.balanceCurrency
                          )}`,
                      provider.balanceToppedUpAmount === null
                        ? null
                        : `topped up ${balanceMoney(
                            provider.balanceToppedUpAmount,
                            provider.balanceCurrency
                          )}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")
              }
            />
          )}
          <Metric label="Month accrued" value={money(billingBasisMicroUsd)} />
          <Metric label="Projected month-end" value={money(provider.projectedMonthEndMicroUsd)} />
          <Metric
            label="Provider billing limit (DB reference)"
            value={
              providerBillingLimitMicroUsd === null
                ? "Not configured"
                : money(providerBillingLimitMicroUsd)
            }
            detail={
              provider.providerBillingHeadroomMicroUsd === null
                ? "Reference only · Set in Edit profile"
                : `${money(provider.providerBillingHeadroomMicroUsd)} headroom · Not enforced by Tomverse`
            }
            valueClass={
              provider.providerBillingHeadroomMicroUsd !== null &&
              provider.providerBillingHeadroomMicroUsd < 0
                ? "text-red-300"
                : "text-white"
            }
          />
          <Metric
            label="Tomverse enforced monthly cap"
            value={money(provider.monthBudgetMicroUsd)}
            detail={`${money(provider.internalBudgetHeadroomMicroUsd)} headroom · ${internalBudgetSourceDetail} · Request blocking`}
            valueClass={provider.internalBudgetHeadroomMicroUsd < 0 ? "text-red-300" : "text-white"}
          />
          <Metric
            label="Expected effective ceiling (lower limit)"
            value={money(provider.expectedEffectiveCeilingMicroUsd)}
            detail={`${money(provider.expectedEffectiveHeadroomMicroUsd)} expected headroom`}
            valueClass={provider.expectedEffectiveHeadroomMicroUsd < 0 ? "text-red-300" : "text-white"}
          />
        </div>
        <p className={`mt-3 rounded-xl border px-3 py-2 text-xs leading-5 ${limitAlignmentClass}`}>
          {limitAlignmentCopy}
        </p>
        {provider.billingProfile.note && (
          <p className="mt-2 text-[11px] text-zinc-500">
            Profile note · {provider.billingProfile.note}
          </p>
        )}
        {billingEditorOpen && canManageCredits && (
          <form
            onSubmit={submitBilling}
            className="mt-4 grid gap-3 rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 md:grid-cols-2 xl:grid-cols-5 xl:items-end"
          >
            <label className="grid gap-1.5 text-xs font-semibold text-zinc-300">
              Pricing model
              <select
                value={pricingModel}
                onChange={(event) => setPricingModel(event.target.value as ProviderPricingModel)}
                className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-500"
              >
                {Object.entries(pricingModelCopy).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-xs font-semibold text-zinc-300">
              Settlement
              <select
                value={settlementModel}
                onChange={(event) => setSettlementModel(event.target.value as ProviderSettlementModel)}
                className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-500"
              >
                {Object.entries(settlementModelCopy).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-xs font-semibold text-zinc-300">
              Provider limit (USD)
              <input
                type="number"
                inputMode="decimal"
                min="0"
                max="1000000"
                step="0.01"
                value={monthlyLimitUsd}
                onChange={(event) => setMonthlyLimitUsd(event.target.value)}
                placeholder="Optional"
                className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-500"
              />
            </label>
            <label className="grid gap-1.5 text-xs font-semibold text-zinc-300">
              Verification note
              <input
                type="text"
                maxLength={300}
                value={billingNote}
                onChange={(event) => setBillingNote(event.target.value)}
                placeholder="Checked in provider console"
                className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-500"
              />
            </label>
            <button
              type="submit"
              disabled={!monthlyLimitIsValid || savingBilling}
              className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {savingBilling ? "Saving" : "Save profile"}
            </button>
          </form>
        )}
      </div>

      {tracksCredit && (
        <div className="mt-5 border-t border-zinc-800 pt-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <CircleDollarSign className="mt-0.5 h-5 w-5 text-emerald-300" />
              <div>
                <PanelLabel>
                  {provider.billingProfile.settlementModel === "hybrid"
                    ? "Optional credit checkpoint"
                    : "Prepaid credit checkpoint"}
                </PanelLabel>
                <p className="mt-1 text-xs leading-5 text-zinc-500">
                  Saves a manually verified credit in DB and subtracts internal
                  usage recorded after the checkpoint. It does not change routing
                  or provider health.
                </p>
              </div>
            </div>
            {canManageCredits && (
              <button
                type="button"
                onClick={toggleCreditEditor}
                className="inline-flex h-9 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-200 transition hover:bg-zinc-800"
              >
                {creditEditorOpen ? "Close editor" : "Set credit"}
              </button>
            )}
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Metric
              label="Opening credit"
              value={
                provider.credit.configuredCreditMicroUsd === null
                  ? provider.billingProfile.settlementModel === "hybrid"
                    ? "Not set (optional)"
                    : "Not configured"
                  : money(provider.credit.configuredCreditMicroUsd)
              }
            />
            <Metric label="Tracked usage" value={money(provider.credit.usedSinceCheckpointMicroUsd)} />
            <Metric
              label="Estimated remaining"
              value={
                estimatedBalance === null
                  ? provider.billingProfile.settlementModel === "hybrid"
                    ? "Not set (optional)"
                    : "Not configured"
                  : money(estimatedBalance)
              }
              detail={
                provider.creditRemainingPercent === null
                  ? undefined
                  : `${provider.creditRemainingPercent.toFixed(1)}% of checkpoint remaining${
                      provider.creditAlertLevel === "none"
                        ? ""
                        : ` · ${provider.creditAlertLevel}% alert active`
                    }`
              }
              valueClass={creditAlertClass(provider.creditAlertLevel)}
            />
          </div>
          {provider.credit.checkpointAt && (
            <p className="mt-2 text-[11px] text-zinc-500">
              Checkpoint {dateLabel(provider.credit.checkpointAt, "Not configured")}
              {provider.credit.note ? ` · ${provider.credit.note}` : ""}
            </p>
          )}
          {creditEditorOpen && canManageCredits && (
            <form
              onSubmit={submitCredit}
              className="mt-4 grid gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 md:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)_auto] md:items-end"
            >
              <label className="grid gap-1.5 text-xs font-semibold text-zinc-300">
                Current credit (USD)
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="1000000"
                  step="0.01"
                  value={creditUsd}
                  onChange={(event) => setCreditUsd(event.target.value)}
                  placeholder="100.00"
                  className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-emerald-500"
                />
              </label>
              <label className="grid gap-1.5 text-xs font-semibold text-zinc-300">
                Note (optional)
                <input
                  type="text"
                  maxLength={300}
                  value={creditNote}
                  onChange={(event) => setCreditNote(event.target.value)}
                  placeholder="Provider console balance checked"
                  className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-emerald-500"
                />
              </label>
              <button
                type="submit"
                disabled={!creditIsValid || savingCredit}
                className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-bold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                {savingCredit ? "Saving" : "Save checkpoint"}
              </button>
            </form>
          )}
        </div>
      )}

      <div className="mt-5 grid gap-4 border-t border-zinc-800 pt-5 lg:grid-cols-2">
        <div>
          <PanelLabel>Recent error log</PanelLabel>
          {provider.recentErrors.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">
              No provider errors recorded today.
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {provider.recentErrors.map((error) => (
                <button
                  key={`${error.code}-${error.updatedAt}`}
                  type="button"
                  onClick={() =>
                    setSelectedErrorCode((current) =>
                      current === error.code ? null : error.code
                    )
                  }
                  aria-expanded={selectedErrorCode === error.code}
                  className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-left text-xs transition hover:border-zinc-700 hover:bg-zinc-900"
                >
                  <span className="min-w-0 truncate font-semibold text-zinc-200">
                    {error.code}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-zinc-500">
                    {error.count} / {dateLabel(error.updatedAt)}
                    <ChevronDown
                      className={`h-3.5 w-3.5 transition-transform ${
                        selectedErrorCode === error.code ? "rotate-180" : ""
                      }`}
                    />
                  </span>
                </button>
              ))}
              {selectedError ? (
                <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-3">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" />
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-blue-100">
                        {selectedError.code}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-zinc-400">
                        {selectedError.explanation}
                      </p>
                    </div>
                  </div>
                  {selectedErrorEvents.length === 0 ? (
                    <p className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-100/80">
                      Historical aggregate only. This error was recorded before event-level
                      diagnostics were enabled, so its original trace and provider response
                      cannot be reconstructed.
                    </p>
                  ) : (
                    <div className="mt-3 space-y-2">
                      {selectedErrorEvents.map((event) => (
                        <div
                          key={event.id}
                          className="rounded-lg border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-xs"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-black text-zinc-200">
                              {event.modelId || "Provider-level"} · {event.phase}
                            </span>
                            <span className="text-zinc-500">
                              {dateLabel(event.createdAt)}
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                            {event.errorName ? (
                              <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-300">
                                {event.errorName}
                              </span>
                            ) : null}
                            {event.errorCode ? (
                              <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-300">
                                {event.errorCode}
                              </span>
                            ) : null}
                            {event.httpStatus ? (
                              <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-red-200">
                                HTTP {event.httpStatus}
                              </span>
                            ) : null}
                            {event.retryable !== null ? (
                              <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-300">
                                {event.retryable ? "Retryable" : "Not retryable"}
                              </span>
                            ) : null}
                          </div>
                          {event.message ? (
                            <p className="mt-2 break-words text-xs leading-5 text-zinc-400">
                              {event.message}
                            </p>
                          ) : null}
                          <p className="mt-2 break-all font-mono text-[10px] text-zinc-600">
                            Trace {event.traceId}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </div>
        <div>
          <PanelLabel>Model 5-minute incidents</PanelLabel>
          {provider.modelIncidents.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">
              No model-specific incidents in the current 5-minute window.
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {provider.modelIncidents.map((incident) => (
                <div
                  key={incident.modelId}
                  className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-semibold text-red-100">
                      {incident.modelName}
                    </span>
                    <span className="shrink-0 text-red-200">
                      {incident.failureCount5m} failures
                    </span>
                  </div>
                  <p className="mt-1 truncate text-red-200/70">
                    {incident.recentErrorCode || "UNKNOWN"} /{" "}
                    {dateLabel(incident.updatedAt)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
        </>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  detail,
  valueClass = "text-white",
}: {
  label: string;
  value: string;
  detail?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="text-zinc-500">{label}</div>
      <div className={`mt-1 truncate font-semibold ${valueClass}`}>{value}</div>
      {detail && <div className="mt-1 text-[11px] leading-4 text-zinc-500">{detail}</div>}
    </div>
  );
}

function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
      {children}
    </div>
  );
}

export function AdminProviderHealthPanel({
  initialDashboard,
  canManageCredits,
  canRunVerification = false,
  providerFilter,
}: {
  initialDashboard: ProviderHealthDashboard;
  canManageCredits: boolean;
  /** ops:write. Gates the verification and recovery controls in the UI; the
   *  API enforces the same permission independently. */
  canRunVerification?: boolean;
  providerFilter?: AiProvider;
}) {
  const [dashboard, setDashboard] = useState(initialDashboard);
  const [refreshing, setRefreshing] = useState(false);
  const [savingProvider, setSavingProvider] = useState<AiProvider | null>(null);
  const [savingBillingProvider, setSavingBillingProvider] = useState<AiProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verificationSummaries, setVerificationSummaries] = useState<
    Record<string, ProviderVerificationSummary>
  >({});
  // One provider at a time for each action, so a second click while a request
  // is in flight cannot start a second billed call.
  const [verifyingProvider, setVerifyingProvider] = useState<AiProvider | null>(
    null
  );
  const [recoveringProvider, setRecoveringProvider] =
    useState<AiProvider | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshDashboard = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/admin/provider-health", {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Provider API returned ${response.status}.`);
      }
      const nextDashboard = (await response.json()) as ProviderHealthDashboard;
      setDashboard(
        providerFilter
          ? { ...nextDashboard, providers: nextDashboard.providers.filter((row) => row.provider === providerFilter) }
          : nextDashboard
      );
      setError(null);
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Provider data refresh failed."
      );
    } finally {
      setRefreshing(false);
    }
  }, [providerFilter]);

  const refreshVerification = useCallback(async () => {
    if (!canRunVerification) return;
    try {
      const response = await fetch("/api/admin/provider-health/verify", {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return;
      const data = (await response.json()) as {
        providers?: Record<string, ProviderVerificationSummary>;
      };
      setVerificationSummaries(data.providers || {});
    } catch {
      // Verification history is supplementary; the dashboard still renders
      // without it, and the error banner is reserved for actions the operator
      // actually asked for.
    }
  }, [canRunVerification]);

  const runVerification = useCallback<RunVerification>(
    async (provider) => {
      if (verifyingProvider || recoveringProvider) return false;
      setVerifyingProvider(provider);
      setNotice(null);
      try {
        const response = await fetch("/api/admin/provider-health/verify", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ provider, acknowledgeProviderCost: true }),
        });
        const data = (await response.json().catch(() => null)) as
          | { check?: ProviderVerificationCheck; error?: string }
          | null;
        if (!response.ok) {
          throw new Error(
            data?.error || `Verification API returned ${response.status}.`
          );
        }
        setNotice(
          data?.check?.status === "success"
            ? `Verification for ${provider} succeeded.`
            : `Verification for ${provider} returned ${data?.check?.status || "no result"}.`
        );
        setError(null);
        return data?.check?.status === "success";
      } catch (verifyError) {
        setError(
          verifyError instanceof Error
            ? verifyError.message
            : "Provider verification failed."
        );
        return false;
      } finally {
        setVerifyingProvider(null);
        await refreshVerification();
        await refreshDashboard();
      }
    },
    [recoveringProvider, refreshDashboard, refreshVerification, verifyingProvider]
  );

  const runRecovery = useCallback<RunRecovery>(
    async (provider, checkId) => {
      if (verifyingProvider || recoveringProvider) return false;
      setRecoveringProvider(provider);
      setNotice(null);
      try {
        const response = await fetch("/api/admin/provider-health/recover", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ provider, checkId }),
        });
        const data = (await response.json().catch(() => null)) as
          | {
              previousConsecutiveFailures?: number;
              error?: string;
            }
          | null;
        if (!response.ok) {
          throw new Error(
            data?.error || `Recovery API returned ${response.status}.`
          );
        }
        setNotice(
          `Cleared ${data?.previousConsecutiveFailures ?? 0} consecutive failures for ${provider}. The last successful traffic timestamp was not modified.`
        );
        setError(null);
        return true;
      } catch (recoveryError) {
        setError(
          recoveryError instanceof Error
            ? recoveryError.message
            : "Provider recovery failed."
        );
        return false;
      } finally {
        setRecoveringProvider(null);
        await refreshVerification();
        await refreshDashboard();
      }
    },
    [recoveringProvider, refreshDashboard, refreshVerification, verifyingProvider]
  );

  const saveProviderCredit = useCallback<SaveCredit>(
    async (provider, creditUsd, note) => {
      setSavingProvider(provider);
      try {
        const response = await fetch("/api/admin/provider-credits", {
          method: "PATCH",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ provider, creditUsd, note: note || null }),
        });
        const data = (await response.json().catch(() => null)) as
          | ProviderHealthDashboard
          | { error?: string }
          | null;
        if (!response.ok) {
          throw new Error(
            data && "error" in data && data.error
              ? data.error
              : `Credit API returned ${response.status}.`
          );
        }
        const nextDashboard = data as ProviderHealthDashboard;
        setDashboard(
          providerFilter
            ? { ...nextDashboard, providers: nextDashboard.providers.filter((row) => row.provider === providerFilter) }
            : nextDashboard
        );
        setError(null);
        return true;
      } catch (saveError) {
        setError(
          saveError instanceof Error
            ? saveError.message
            : "Provider credit update failed."
        );
        return false;
      } finally {
        setSavingProvider(null);
      }
    },
    [providerFilter]
  );

  const saveProviderBilling = useCallback<SaveBilling>(
    async (provider, profile) => {
      setSavingBillingProvider(provider);
      try {
        const response = await fetch("/api/admin/provider-billing", {
          method: "PATCH",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            provider,
            ...profile,
            note: profile.note || null,
          }),
        });
        const data = (await response.json().catch(() => null)) as
          | ProviderHealthDashboard
          | { error?: string }
          | null;
        if (!response.ok) {
          throw new Error(
            data && "error" in data && data.error
              ? data.error
              : `Billing profile API returned ${response.status}.`
          );
        }
        const nextDashboard = data as ProviderHealthDashboard;
        setDashboard(
          providerFilter
            ? { ...nextDashboard, providers: nextDashboard.providers.filter((row) => row.provider === providerFilter) }
            : nextDashboard
        );
        setError(null);
        return true;
      } catch (saveError) {
        setError(
          saveError instanceof Error
            ? saveError.message
            : "Provider billing profile update failed."
        );
        return false;
      } finally {
        setSavingBillingProvider(null);
      }
    },
    [providerFilter]
  );

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "visible") return;
      void refreshDashboard();
      // Verification history rides the same cadence as the dashboard, so the
      // "already used for a recovery" flag on a check can never be stale
      // relative to the failure counter it would be used against.
      void refreshVerification();
    };
    const initialRefresh = window.setTimeout(refreshWhenVisible, 0);
    const interval = window.setInterval(refreshWhenVisible, REFRESH_INTERVAL_MS);
    window.addEventListener("tomverse:provider-health-refresh", refreshWhenVisible);
    window.addEventListener("admin:refresh", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(initialRefresh);
      window.removeEventListener(
        "tomverse:provider-health-refresh",
        refreshWhenVisible
      );
      window.removeEventListener("admin:refresh", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [refreshDashboard, refreshVerification]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-bold text-zinc-200">Live admin API panel</p>
          <p className="mt-1 text-xs text-zinc-500">
            Admin API refreshes every 30 seconds · Updated{" "}
            {dateLabel(dashboard.generatedAt)}
          </p>
          <p
            className={`mt-1 text-xs ${
              dashboard.probeCostCapMicroUsd > 0 &&
              dashboard.probeCostTodayMicroUsd >= dashboard.probeCostCapMicroUsd
                ? "font-bold text-amber-300"
                : "text-zinc-500"
            }`}
          >
            Synthetic probe spend today: {money(dashboard.probeCostTodayMicroUsd)} of{" "}
            {money(dashboard.probeCostCapMicroUsd)} daily cap
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshDashboard()}
          disabled={refreshing}
          className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-bold text-zinc-200 transition hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Refreshing" : "Refresh now"}
        </button>
      </div>
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-200"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error} Showing the last successful snapshot.
        </div>
      )}
      {notice && (
        <div
          role="status"
          data-testid="provider-verification-notice"
          className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm font-semibold text-emerald-200"
        >
          <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
          {notice}
        </div>
      )}
      {dashboard.providers.map((provider) => (
        <ProviderRow
          key={provider.provider}
          provider={provider}
          canManageCredits={canManageCredits}
          canRunVerification={canRunVerification}
          verificationSummary={verificationSummaries[provider.provider] ?? null}
          evaluatedAt={dashboard.generatedAt}
          verifying={verifyingProvider === provider.provider}
          recovering={recoveringProvider === provider.provider}
          savingCredit={savingProvider === provider.provider}
          savingBilling={savingBillingProvider === provider.provider}
          onSaveCredit={saveProviderCredit}
          onSaveBilling={saveProviderBilling}
          onVerify={runVerification}
          onRecover={runRecovery}
        />
      ))}
    </div>
  );
}
