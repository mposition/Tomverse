export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import {
  ATTESTATION_KINDS,
  type AttestationKind,
} from "@/lib/emailCampaignAttestationCore";
import {
  campaignAttestationStates,
  recordCampaignAttestation,
  withdrawCampaignAttestation,
} from "@/lib/emailCampaignService";
import { prisma } from "@/lib/prisma";

type Context = { params: Promise<{ campaignId: string }> };

/**
 * Where a person states the three things no field holds.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §13.3.
 *
 * The route exists so those three are entered as somebody's statement rather
 * than inferred. It records who and when, and it takes the content digest from
 * the campaign rather than from the request -- an attestation bound to a digest
 * its author supplied would be bound to whatever they believed the copy was,
 * which is the belief being checked.
 *
 * Not approval-gated. An attestation is one person's statement about what they
 * checked; requiring a second person to co-sign it would make it a decision,
 * and the decision is the approval.
 */

const recordSchema = z
  .object({
    kind: z.enum(ATTESTATION_KINDS as unknown as [AttestationKind, ...AttestationKind[]]),
    note: z.string().trim().max(1_000).optional(),
  })
  .strict();

const withdrawSchema = z
  .object({
    kind: z.enum(ATTESTATION_KINDS as unknown as [AttestationKind, ...AttestationKind[]]),
  })
  .strict();

export async function GET(req: Request, context: Context) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const { campaignId } = await context.params;
    await consumeApiRateLimit(req, session.user.id, "admin-email-campaigns-read", {
      minute: 60,
      day: 2_000,
    });
    return NextResponse.json({
      attestations: await campaignAttestationStates(campaignId),
    });
  } catch (error) {
    return apiSecurityResponse(error);
  }
}

export async function POST(req: Request, context: Context) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const { campaignId } = await context.params;
    await consumeApiRateLimit(req, session.user.id, "admin-email-campaigns-write", {
      minute: 20,
      day: 300,
    });

    const body = await readLimitedJson(req, 8 * 1024, recordSchema);

    const campaign = await prisma.emailCampaign.findUnique({
      where: { id: campaignId },
      select: { status: true },
    });
    if (!campaign) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // An attestation is the account of somebody who is signing their name, so
    // it needs a name. A session with no email cannot supply one, and storing
    // "unknown" would leave a statement nobody made.
    const attestedByEmail = session.user.email?.trim();
    if (!attestedByEmail) {
      return NextResponse.json(
        {
          error:
            "An attestation records who made it, and this session carries no email address to record.",
          code: "ATTESTATION_ACTOR_UNKNOWN",
        },
        { status: 409 }
      );
    }

    const attestation = await recordCampaignAttestation({
      campaignId,
      kind: body.kind,
      attestedByEmail,
      note: body.note ?? null,
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "email_campaign.attested",
      targetType: "EmailCampaign",
      targetId: campaignId,
      summary: `Attested ${body.kind}.`,
      metadata: { kind: body.kind, hasNote: Boolean(body.note) },
    });

    return NextResponse.json({
      attestation,
      attestations: await campaignAttestationStates(campaignId),
    });
  } catch (error) {
    return apiSecurityResponse(error);
  }
}

export async function DELETE(req: Request, context: Context) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const { campaignId } = await context.params;
    await consumeApiRateLimit(req, session.user.id, "admin-email-campaigns-write", {
      minute: 20,
      day: 300,
    });

    const body = await readLimitedJson(req, 4 * 1024, withdrawSchema);
    const removed = await withdrawCampaignAttestation({
      campaignId,
      kind: body.kind,
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "email_campaign.attestation_withdrawn",
      targetType: "EmailCampaign",
      targetId: campaignId,
      summary: `Withdrew ${body.kind}.`,
      metadata: { kind: body.kind, removed: removed.count },
    });

    return NextResponse.json({
      removed: removed.count,
      attestations: await campaignAttestationStates(campaignId),
    });
  } catch (error) {
    return apiSecurityResponse(error);
  }
}
