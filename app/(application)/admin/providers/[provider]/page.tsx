import { notFound } from "next/navigation";
import { AdminProviderHealthPanel } from "@/components/admin/AdminProviderHealthPanel";
import { AdminProviderUsageSyncPanel } from "@/components/admin/AdminProviderUsageSyncPanel";
import { getAdminRole } from "@/lib/adminAuth";
import { authOptions } from "@/lib/auth";
import type { AiProvider } from "@/lib/models";
import {
  getProviderHealthDashboard,
  PROVIDER_DISPLAY_NAMES,
} from "@/lib/providerMonitoring";
import { getServerSession } from "next-auth/next";

export default async function AdminProviderDetailPage({
  params,
}: PageProps<"/admin/providers/[provider]">) {
  const [{ provider }, session, dashboard] = await Promise.all([
    params,
    getServerSession(authOptions),
    getProviderHealthDashboard({ includeErrorEvents: true }),
  ]);
  if (!(provider in PROVIDER_DISPLAY_NAMES)) notFound();
  const providerId = provider as AiProvider;
  const selected = dashboard.providers.find((row) => row.provider === providerId);
  if (!selected) notFound();
  const role = getAdminRole(session);
  return (
    <section className="flex flex-col gap-4">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
        <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">Provider workspace</p>
        <h2 className="mt-2 text-xl font-black text-white">{PROVIDER_DISPLAY_NAMES[providerId]}</h2>
        <p className="mt-1 text-sm text-zinc-500">Summary, usage diagnostics, billing profile, credit checkpoint, recent errors, fallback policy, and manual operations.</p>
      </div>
      <AdminProviderUsageSyncPanel />
      <AdminProviderHealthPanel
        initialDashboard={{ ...dashboard, providers: [selected] }}
        canManageCredits={role === "owner" || role === "billing"}
        providerFilter={providerId}
      />
    </section>
  );
}
