export const dynamic = "force-dynamic";

import Link from "next/link";
import { headers } from "next/headers";
import type { Metadata } from "next";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CircleHelp,
  XCircle,
} from "lucide-react";
import {
  getProviderHealthDashboard,
  type ProviderHealthDashboard,
  type ProviderHealthRow,
} from "@/lib/providerMonitoring";
import {
  summarizeMonitoredStatuses,
  type PublicProviderStatus,
} from "@/lib/providerPublicStatusCore";
import { getScheduledJobsDashboard } from "@/lib/scheduledJobs";
import { createPageMetadata, localizedQueryPath, queryLanguageAlternates } from "@/lib/seo";
import { DOCUMENT_LANGUAGE_HEADER } from "@/lib/documentLanguage";
import { StatusPageChrome } from "@/components/marketing/StatusPageChrome";
import { PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE } from "@/lib/landingWorkspaceEntry";
import { describeProbeSchedulerDelay } from "@/lib/statusPageEvidence";
import {
  describePublicStatusAffectedModels,
  describePublicStatusEvidence,
  formatPublicStatusUtc,
  getPublicStatusCopy,
  localizePublicStatusSummary,
  publicStatusSchedulerNotice,
  resolvePublicStatusLanguage,
} from "@/lib/publicStatusCopy";

type StatusPageProps = {
  searchParams: Promise<{ lang?: string | string[] }>;
};

const statusPageLanguage = async (searchParams: StatusPageProps["searchParams"]) => {
  const [query, requestHeaders] = await Promise.all([searchParams, headers()]);
  return resolvePublicStatusLanguage({
    searchLanguage: query.lang,
    documentLanguage: requestHeaders.get(DOCUMENT_LANGUAGE_HEADER),
    acceptLanguage: requestHeaders.get("accept-language"),
  });
};

export async function generateMetadata({ searchParams }: StatusPageProps): Promise<Metadata> {
  const language = await statusPageLanguage(searchParams);
  const copy = getPublicStatusCopy(language);
  const metadata = createPageMetadata({
    title: copy.metadataTitle,
    description: copy.metadataDescription,
    locale: language,
    path: localizedQueryPath(language, "/status"),
  });
  return {
    ...metadata,
    alternates: {
      ...metadata.alternates,
      languages: queryLanguageAlternates("/status"),
    },
  };
}

// Unknown is deliberately styled as neutral (zinc), never green/emerald --
// "no evidence" must never look like a healthy signal.
const statusClass: Record<PublicProviderStatus, string> = {
  operational: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  degraded: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  incident: "border-red-500/30 bg-red-500/10 text-red-200",
  unknown: "border-zinc-600/40 bg-zinc-700/20 text-zinc-300",
};

const statusIcon = (status: PublicProviderStatus) => {
  if (status === "operational") return <CheckCircle2 className="h-4 w-4" aria-hidden="true" />;
  if (status === "degraded") return <AlertTriangle className="h-4 w-4" aria-hidden="true" />;
  if (status === "incident") return <XCircle className="h-4 w-4" aria-hidden="true" />;
  return <CircleHelp className="h-4 w-4" aria-hidden="true" />;
};

const summaryToneClass: Record<PublicProviderStatus, string> = {
  operational: "text-emerald-200",
  degraded: "text-amber-200",
  incident: "text-red-200",
  unknown: "text-zinc-300",
};

const TimeOrUnrecorded = ({
  value,
  fallback,
}: {
  value: string | null;
  fallback: string;
}) => {
  if (!value) return <span>{fallback}</span>;
  return (
    <time dateTime={value} title={formatPublicStatusUtc(value)}>
      {formatPublicStatusUtc(value)}
    </time>
  );
};

// The public page and the admin panel (components/admin/AdminProviderHealthPanel.tsx)
// both read provider.publicStatus straight off the dashboard -- neither computes
// its own verdict, so they can't contradict each other (see
// lib/providerPublicStatusCore.ts for the shared judgment function).
const buildEmptyDashboard = (): ProviderHealthDashboard => ({
  generatedAt: new Date().toISOString(),
  providers: [],
  tierLimits: { Free: "", Pro: "", Max: "" },
  notificationChannels: { email: false, slack: false, discord: false },
  probeCostTodayMicroUsd: 0,
  probeCostCapMicroUsd: 0,
});

export default async function StatusPage({ searchParams }: StatusPageProps) {
  const language = await statusPageLanguage(searchParams);
  const copy = getPublicStatusCopy(language);
  let dashboard: ProviderHealthDashboard;
  let dataUnavailable = false;
  try {
    dashboard = await getProviderHealthDashboard();
  } catch (error) {
    console.error("Failed to load provider health dashboard for /status:", error);
    dashboard = buildEmptyDashboard();
    dataUnavailable = true;
  }

  // A delayed probe scheduler is a monitoring problem, not a provider
  // problem -- shown as a distinct page-level notice, never folded into
  // any individual provider's status. Best-effort: if this itself can't be
  // loaded, the page still renders normally with no delay notice, rather
  // than failing the whole page over a secondary signal.
  const probeSchedulerJob = await getScheduledJobsDashboard()
    .then((jobs) => jobs.find((job) => job.key === "provider_probe") ?? null)
    .catch(() => null);
  const probeSchedulerDelay = describeProbeSchedulerDelay(probeSchedulerJob);
  const schedulerNotice = publicStatusSchedulerNotice(probeSchedulerDelay, probeSchedulerJob, language);

  const providers: ProviderHealthRow[] = dashboard.providers;
  const summary = summarizeMonitoredStatuses(
    dataUnavailable ? ["unknown"] : providers.map((provider) => provider.publicStatus)
  );
  const localizedSummary = localizePublicStatusSummary(summary, language, {
    providerCount: providers.length,
    dataUnavailable,
  });
  const evidenceAsOf = new Date(dashboard.generatedAt);
  const counts = {
    operational: providers.filter((p) => p.publicStatus === "operational").length,
    degraded: providers.filter((p) => p.publicStatus === "degraded").length,
    incident: providers.filter((p) => p.publicStatus === "incident").length,
    unknown: providers.filter((p) => p.publicStatus === "unknown").length,
  };

  return (
    <StatusPageChrome language={language} guestTrialAvailable={PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE}>
    <main lang={language} className="min-h-screen bg-zinc-950 px-5 py-8 text-zinc-100">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <header className="rounded-3xl border border-zinc-800 bg-gradient-to-br from-zinc-900 to-zinc-950 p-6">
          <Link
            href={`/${language}`}
            className="inline-flex cursor-pointer items-center gap-2 text-sm font-bold text-blue-300 hover:text-blue-200"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {copy.backHome}
          </Link>
          <div className="mt-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-blue-200">
                <Activity className="h-3.5 w-3.5" aria-hidden="true" />
                {copy.eyebrow}
              </div>
              <h1
                className={`mt-4 text-3xl font-black tracking-tight md:text-5xl ${summaryToneClass[summary.tone]}`}
              >
                {localizedSummary.headline}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400">
                {copy.introduction}
              </p>
              {dataUnavailable && (
                <p
                  role="status"
                  className="mt-3 max-w-2xl rounded-xl border border-zinc-700 bg-zinc-900/70 px-3 py-2 text-sm text-zinc-300"
                >
                  {copy.dataUnavailable}
                </p>
              )}
              {schedulerNotice && (
                <p
                  role="status"
                  className="mt-3 max-w-2xl rounded-xl border border-zinc-700 bg-zinc-900/70 px-3 py-2 text-sm text-zinc-300"
                >
                  {schedulerNotice}
                </p>
              )}
            </div>
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-zinc-400">
              {dataUnavailable ? copy.pageGeneratedAt : copy.dataAsOf}{" "}
              <time dateTime={dashboard.generatedAt} title={formatPublicStatusUtc(dashboard.generatedAt)}>
                {formatPublicStatusUtc(dashboard.generatedAt)}
              </time>
            </div>
          </div>
        </header>

        <section className="grid gap-3 grid-cols-2 md:grid-cols-4">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-400">
              {copy.statuses.operational}
            </p>
            <p className="mt-2 text-3xl font-black text-emerald-200">{counts.operational}</p>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-400">
              {copy.statuses.degraded}
            </p>
            <p className="mt-2 text-3xl font-black text-amber-200">{counts.degraded}</p>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-400">
              {copy.statuses.incident}
            </p>
            <p className="mt-2 text-3xl font-black text-red-200">{counts.incident}</p>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-400">
              {copy.statuses.unknown}
            </p>
            <p className="mt-2 text-3xl font-black text-zinc-300">{counts.unknown}</p>
          </div>
        </section>

        <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
          <h2 className="text-xl font-black text-white">{copy.providerTitle}</h2>
          <div className="mt-5 grid gap-3">
            {providers.map((provider) => {
              const lastCheckedAt = [provider.lastSuccessAt, provider.lastFailureAt]
                .filter((value): value is string => Boolean(value))
                .sort()
                .at(-1) ?? null;
              const lastProbeCheckedAt = [provider.lastProbeSuccessAt, provider.lastProbeFailureAt]
                .filter((value): value is string => Boolean(value))
                .sort()
                .at(-1) ?? null;
              const lastManualCheckedAt = [provider.lastVerificationSuccessAt, provider.lastVerificationFailureAt]
                .filter((value): value is string => Boolean(value))
                .sort()
                .at(-1) ?? null;
              const evidenceDescription = describePublicStatusEvidence(provider, language, evidenceAsOf);
              const statusDetailsId = `public-status-${provider.provider}`;
              const affectedModelNames = provider.modelIncidents.map(
                (incident) => incident.modelName
              );
              return (
                <div
                  key={provider.provider}
                  className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-base font-bold text-white">{provider.displayName}</p>
                      <p className="mt-1 text-xs text-zinc-500">
                        {copy.lastSuccess}:{" "}
                        <TimeOrUnrecorded
                          value={provider.lastSuccessAt}
                          fallback={copy.unrecorded}
                        />
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {copy.lastTraffic}:{" "}
                        <TimeOrUnrecorded value={lastCheckedAt} fallback={copy.never} />
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {copy.lastProbe}:{" "}
                        <TimeOrUnrecorded value={lastProbeCheckedAt} fallback={copy.never} />
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {copy.lastManual}:{" "}
                        <TimeOrUnrecorded value={lastManualCheckedAt} fallback={copy.never} />
                      </p>
                    </div>
                    <span
                      aria-describedby={statusDetailsId}
                      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-bold ${statusClass[provider.publicStatus]}`}
                    >
                      {statusIcon(provider.publicStatus)}
                      {copy.statuses[provider.publicStatus]}
                    </span>
                  </div>
                  <p id={statusDetailsId} className="mt-3 text-xs leading-5 text-zinc-400">
                    {evidenceDescription.reason}{" "}
                    {evidenceDescription.source}
                  </p>
                  {affectedModelNames.length > 0 && (
                    <p className="mt-2 text-xs leading-5 text-zinc-500">
                      {describePublicStatusAffectedModels(affectedModelNames, language)}
                    </p>
                  )}
                </div>
              );
            })}
            {providers.length === 0 && (
              <p className="text-sm text-zinc-400">{dataUnavailable ? copy.emptyUnavailable : copy.empty}</p>
            )}
          </div>
        </section>
      </div>
    </main>
    </StatusPageChrome>
  );
}
