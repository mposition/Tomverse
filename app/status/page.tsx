export const dynamic = "force-dynamic";

import Link from "next/link";
import { Activity, CheckCircle2, XCircle } from "lucide-react";
import {
  getProviderHealthDashboard,
  type ProviderHealthRow,
} from "@/lib/providerMonitoring";

type PublicProviderStatus = "operational" | "incident";

const statusCopy: Record<PublicProviderStatus, string> = {
  operational: "Operational",
  incident: "Incident",
};

const statusClass: Record<PublicProviderStatus, string> = {
  operational: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  incident: "border-red-500/30 bg-red-500/10 text-red-200",
};

const publicStatusFor = (provider: ProviderHealthRow): PublicProviderStatus => {
  if (
    provider.status === "outage" ||
    provider.modelIncidents.some((incident) => incident.failureCount5m >= 3)
  ) {
    return "incident";
  }
  return "operational";
};

const iconFor = (status: PublicProviderStatus) => {
  if (status === "operational") return <CheckCircle2 className="h-4 w-4" />;
  return <XCircle className="h-4 w-4" />;
};

export default async function StatusPage() {
  const dashboard = await getProviderHealthDashboard();
  const providers = dashboard.providers.map((provider) => ({
    ...provider,
    publicStatus: publicStatusFor(provider),
    publicIncidents: provider.modelIncidents.filter(
      (incident) => incident.failureCount5m >= 3
    ),
  }));
  const outageCount = providers.filter(
    (provider) => provider.publicStatus === "incident"
  ).length;
  const overall =
    outageCount > 0
      ? "Some providers are currently unavailable"
      : "All monitored providers are operational";

  return (
    <main className="min-h-screen bg-zinc-950 px-5 py-8 text-zinc-100">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <header className="rounded-3xl border border-zinc-800 bg-gradient-to-br from-zinc-900 to-zinc-950 p-6">
          <Link
            href="/"
            className="inline-flex cursor-pointer items-center gap-2 text-sm font-black text-blue-300 hover:text-blue-200"
          >
            Tomverse AI
          </Link>
          <div className="mt-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-black uppercase tracking-[0.18em] text-blue-200">
                <Activity className="h-3.5 w-3.5" />
                Public Status
              </div>
              <h1 className="mt-4 text-3xl font-black tracking-tight text-white md:text-5xl">
                {overall}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400">
                This page reports service-impacting incidents. Internal health warnings and
                diagnostics are reviewed by Tomverse operators.
              </p>
            </div>
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-zinc-400">
              Updated {dashboard.generatedAt.replace("T", " ").slice(0, 16)} UTC
            </div>
          </div>
        </header>

        <section className="grid gap-3 md:grid-cols-2">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
              Operational
            </p>
            <p className="mt-2 text-3xl font-black text-emerald-200">
              {providers.length - outageCount}
            </p>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
              Incident
            </p>
            <p className="mt-2 text-3xl font-black text-red-200">{outageCount}</p>
          </div>
        </section>

        <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
          <h2 className="text-xl font-black text-white">Provider Status</h2>
          <div className="mt-5 grid gap-3">
            {providers.map((provider) => (
              <div
                key={provider.provider}
                className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-base font-black text-white">
                      {provider.displayName}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">
                      Last good response: {provider.lastSuccessAt
                        ? provider.lastSuccessAt.replace("T", " ").slice(0, 16)
                        : "Not recorded"}
                    </p>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-black ${statusClass[provider.publicStatus]}`}
                  >
                    {iconFor(provider.publicStatus)}
                    {statusCopy[provider.publicStatus]}
                  </span>
                </div>
                {provider.publicIncidents.length > 0 ? (
                  <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-100">
                    {provider.publicIncidents.length} model incident
                    {provider.publicIncidents.length === 1 ? "" : "s"} in the current
                    monitoring window.
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
