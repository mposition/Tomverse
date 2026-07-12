export const dynamic = "force-dynamic";

import Link from "next/link";
import { Activity, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import {
  getProviderHealthDashboard,
  type ProviderHealthStatus,
} from "@/lib/providerMonitoring";

const statusCopy: Record<ProviderHealthStatus, string> = {
  available: "Operational",
  limited: "Limited",
  outage: "Incident",
};

const statusClass: Record<ProviderHealthStatus, string> = {
  available: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  limited: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  outage: "border-red-500/30 bg-red-500/10 text-red-200",
};

const iconFor = (status: ProviderHealthStatus) => {
  if (status === "available") return <CheckCircle2 className="h-4 w-4" />;
  if (status === "limited") return <AlertTriangle className="h-4 w-4" />;
  return <XCircle className="h-4 w-4" />;
};

export default async function StatusPage() {
  const dashboard = await getProviderHealthDashboard();
  const outageCount = dashboard.providers.filter(
    (provider) => provider.status === "outage"
  ).length;
  const limitedCount = dashboard.providers.filter(
    (provider) => provider.status === "limited"
  ).length;
  const overall =
    outageCount > 0
      ? "Some providers are currently unavailable"
      : limitedCount > 0
        ? "Some providers are limited"
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
                Provider status is based on Tomverse request health, configured API keys,
                recent failures, and operator overrides. Individual upstream providers may
                expose additional detail on their own status pages.
              </p>
            </div>
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-zinc-400">
              Updated {dashboard.generatedAt.replace("T", " ").slice(0, 16)} UTC
            </div>
          </div>
        </header>

        <section className="grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
              Operational
            </p>
            <p className="mt-2 text-3xl font-black text-emerald-200">
              {dashboard.providers.filter((provider) => provider.status === "available").length}
            </p>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
              Limited
            </p>
            <p className="mt-2 text-3xl font-black text-amber-200">{limitedCount}</p>
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
            {dashboard.providers.map((provider) => (
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
                    className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-black ${statusClass[provider.status]}`}
                  >
                    {iconFor(provider.status)}
                    {statusCopy[provider.status]}
                  </span>
                </div>
                {provider.modelIncidents.length > 0 ? (
                  <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-100">
                    {provider.modelIncidents.length} model incident
                    {provider.modelIncidents.length === 1 ? "" : "s"} in the current
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
