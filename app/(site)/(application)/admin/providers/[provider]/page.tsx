import { notFound } from "next/navigation";
import { AdminProviderHealthPanel } from "@/components/admin/AdminProviderHealthPanel";
import { ProviderSyncMoved } from "@/components/admin/providers/ProviderSyncMoved";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { getAdminRole } from "@/lib/adminAuth";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminProvidersPageMessages } from "@/lib/adminMessages/providersPage";
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
  const m = await getAdminMessages(adminProvidersPageMessages);
  return (
    <section className="flex flex-col gap-4">
      <AdminTile title={PROVIDER_DISPLAY_NAMES[providerId]} description={m.detail.description} />
      <ProviderSyncMoved />
      <AdminProviderHealthPanel
        initialDashboard={{ ...dashboard, providers: [selected] }}
        canManageCredits={role === "owner" || role === "billing"}
        canRunVerification={role === "owner" || role === "ops"}
        providerFilter={providerId}
      />
    </section>
  );
}
