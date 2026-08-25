export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";

import { AdminCampaignDetailPanel } from "@/components/admin/AdminCampaignDetailPanel";
import { readAdminCampaign } from "@/lib/adminEmailCampaigns";

/**
 * One campaign.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §12.2, §13.3.
 *
 * The server does one thing here -- decide whether this id exists -- and the
 * panel below fetches everything else from `/api/admin/email-campaigns/[id]`.
 * That is deliberate: every action on this page changes what the gates answer,
 * so the panel has to re-read them anyway, and rendering an initial copy on the
 * server would give an operator two sources for the same verdict with no way to
 * tell which one they are looking at.
 *
 * `notFound()` rather than an empty panel, so a stale link says so.
 */
export default async function AdminCampaignDetailPage({
  params,
}: PageProps<"/admin/email-campaigns/[campaignId]">) {
  const { campaignId } = await params;
  const campaign = await readAdminCampaign(campaignId);
  if (!campaign) notFound();

  return <AdminCampaignDetailPanel campaignId={campaign.id} />;
}
