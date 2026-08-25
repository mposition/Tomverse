export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import {
  listWaveRecipients,
  readAdminCampaign,
  WAVE_RECIPIENT_PAGE_MAX,
} from "@/lib/adminEmailCampaigns";

type Context = { params: Promise<{ campaignId: string }> };

/**
 * One page of one wave's expansion ledger, masked.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §44 (the
 * ledger), §21 D10 (what may be shown of it).
 *
 * ## Why a route of its own
 *
 * The campaign detail response already carries the per-wave counts, and it is
 * read on every visit to the page. A ledger is one row per person per wave, so
 * folding the rows into that response would load an audience-sized list for
 * every operator who opened a campaign to check its schedule. This is the
 * request an operator makes when they have decided to look at people.
 *
 * ## What it never returns
 *
 * An address. `listWaveRecipients` masks before the value leaves it, so the
 * response cannot carry one and neither can the page's HTML. The reveal is a
 * separate, audited POST to `/api/admin/email-deliveries/reveal` with
 * `kind: "campaign_recipient"`.
 *
 * It also never returns the `deliveryId` — only whether one exists. The id is
 * this row's link into the outbox, and a screen showing people has no use for
 * it while an id in a response is an id somebody can ask another endpoint
 * about.
 */
export async function GET(req: Request, context: Context) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const { campaignId } = await context.params;
    await consumeApiRateLimit(req, session.user.id, "admin-email-campaigns-read", {
      minute: 60,
      day: 2000,
    });

    // The campaign has to exist before a wave belonging to it can. Asked first
    // so a stale link answers 404 rather than an empty list, which reads as
    // "this wave reached nobody".
    const campaign = await readAdminCampaign(campaignId);
    if (!campaign) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const url = new URL(req.url);
    const waveId = url.searchParams.get("waveId")?.trim();
    if (!waveId) {
      return NextResponse.json(
        { error: "A waveId is required." },
        { status: 400 }
      );
    }

    const rawLimit = Number(url.searchParams.get("limit"));
    const page = await listWaveRecipients({
      campaignId,
      waveId,
      cursor: url.searchParams.get("cursor")?.trim() || null,
      ...(Number.isFinite(rawLimit) && rawLimit > 0
        ? { limit: Math.min(Math.trunc(rawLimit), WAVE_RECIPIENT_PAGE_MAX) }
        : {}),
    });

    return NextResponse.json(page);
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    console.error("Failed to read the wave ledger.", error);
    return NextResponse.json(
      { error: "Failed to read the wave ledger." },
      { status: 500 }
    );
  }
}
