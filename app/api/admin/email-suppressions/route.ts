export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import {
  adminApprovalErrorResponse,
  runWithAdminApproval,
} from "@/lib/adminApproval";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { listSuppressions } from "@/lib/adminEmailDeliveries";
import { prisma } from "@/lib/prisma";
import { suppressionRemovalProblem } from "@/lib/adminEmailDeliveryFilters";
import {
  APPROVAL_REQUIRED_SUPPRESSION_REASONS,
  GLOBAL_PURPOSE_KEY,
  normalizeSuppressionAddress,
  recordSuppression,
  removeSuppression,
} from "@/lib/emailSuppression";

/**
 * Adding and lifting suppressions, both audited.
 *
 * Contract: docs/policy/email-notifications.md §13.7, §13.3, §5.3.1.
 *
 * §13.7 lists suppression add and remove among the actions that must reach
 * `AdminAuditLog`, and asks for a reason on removal specifically. The asymmetry
 * is the point and it is worth restating: **adding one stops mail; removing one
 * starts mail to an address that a provider, or the person, previously said to
 * stop mailing.** The reason is the only record of why we overrode that.
 *
 * Three levels, by what the entry says:
 *
 *  - `privacy_request` is refused outright. It is the record of someone
 *    exercising a legal right, and the process entitled to lift it is the
 *    privacy process that created it, not a button here.
 *  - `hard_bounce` and `complaint` need a second administrator. §13.3 calls
 *    them permanent, and complaints are what a receiver measures a sending
 *    domain by (§14.5) -- the part of this system that recovers slowest.
 *  - everything else needs a reason that says something, and an audit entry.
 *
 * Our own list is not the provider's. Resend's suppression is account- and
 * region-wide (§5.3.1), so lifting an entry here does not lift one there, and
 * the response says so rather than letting an operator conclude that mail will
 * now flow.
 */

const addSchema = z.object({
  action: z.literal("add"),
  emailAddress: z.string().trim().min(3).max(320).email(),
  purposeKey: z.string().trim().min(1).max(60).optional(),
  note: z.string().trim().max(500).optional(),
});

const removeSchema = z.object({
  action: z.literal("remove"),
  id: z.string().trim().min(1).max(60),
  reason: z.string().trim().min(1).max(1_000),
});

const requestSchema = z.discriminatedUnion("action", [addSchema, removeSchema]);

const REMOVAL_PROBLEM_MESSAGE = {
  reason_too_short:
    "Say why this suppression is being lifted, in a sentence. It is the only record of why mail to this address was re-enabled.",
  reason_too_long: "That reason is too long; keep it under 500 characters.",
  reason_is_boilerplate:
    "That reason says nothing. Name what changed about this address.",
} as const;

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-email-suppressions", {
      minute: 30,
      day: 600,
    });

    const address = new URL(req.url).searchParams.get("address")?.trim();
    const rows = await listSuppressions({
      emailAddress: address ? normalizeSuppressionAddress(address) : null,
      limit: 100,
    });
    return NextResponse.json(
      { rows },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    return NextResponse.json(
      { error: "Failed to read the suppression list." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const body = await readLimitedJson(req, 8 * 1024, requestSchema);

    if (body.action === "add") {
      await consumeApiRateLimit(
        req,
        session.user.id,
        "admin-suppression-add",
        { minute: 10, day: 200 }
      );
      const emailAddress = normalizeSuppressionAddress(body.emailAddress);
      const purposeKey = body.purposeKey ?? GLOBAL_PURPOSE_KEY;
      const result = await recordSuppression({
        emailAddress,
        // `manual` is one of §13.3's permanent reasons, which is what an
        // operator adding an entry by hand means: it does not expire on its
        // own, and lifting it is the audited act below.
        reason: "manual",
        source: "admin",
        purposeKey,
        ...(body.note ? { evidence: { note: body.note } } : {}),
      });

      await writeAdminAuditLog({
        session,
        request: req,
        action: "email_suppression.added",
        targetType: "SuppressionEntry",
        targetId: result.id,
        summary: `Suppressed ${emailAddress} for ${purposeKey === GLOBAL_PURPOSE_KEY ? "all mail" : purposeKey}.`,
        metadata: {
          emailAddress,
          purposeKey,
          reason: "manual",
          strengthened: result.changed,
          ...(body.note ? { note: body.note } : {}),
        },
      });

      return NextResponse.json({ id: result.id, changed: result.changed });
    }

    const problem = suppressionRemovalProblem(body.reason);
    if (problem) {
      return NextResponse.json(
        { error: REMOVAL_PROBLEM_MESSAGE[problem], code: problem },
        { status: 400 }
      );
    }

    await consumeApiRateLimit(
      req,
      session.user.id,
      "admin-suppression-remove",
      { minute: 5, day: 50 }
    );

    // Which reason the *stored* row holds decides whether a second
    // administrator is needed. Deriving that from the request body would let
    // the caller choose its own approval requirement, and the row is read again
    // inside the removal transaction, so this read only picks the path.
    const stored = await prisma.suppressionEntry.findUnique({
      where: { id: body.id },
      select: { reason: true },
    });
    if (!stored) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const lift = async () => removeSuppression({ id: body.id });

    const needsApproval = (
      APPROVAL_REQUIRED_SUPPRESSION_REASONS as readonly string[]
    ).includes(stored.reason);

    const result = needsApproval
      ? await runWithAdminApproval(
          {
            session,
            request: req,
            action: "email_suppression.remove",
            targetType: "SuppressionEntry",
            targetId: body.id,
            payload: { id: body.id },
            reason: body.reason,
          },
          lift
        )
      : await lift();

    if (!result.removed) {
      return NextResponse.json(
        {
          error:
            result.refusal === "unliftable"
              ? "A suppression created by a privacy request is lifted by the privacy process that created it, not from here."
              : "Not found.",
          code: result.refusal,
        },
        { status: result.refusal === "unliftable" ? 409 : 404 }
      );
    }

    await writeAdminAuditLog({
      session,
      request: req,
      action: "email_suppression.removed",
      targetType: "SuppressionEntry",
      targetId: result.entry.id,
      summary: `Lifted the ${result.entry.reason} suppression on ${result.entry.emailAddress}.`,
      metadata: {
        reason: body.reason,
        emailAddress: result.entry.emailAddress,
        scope: result.entry.scope,
        purposeKey: result.entry.purposeKey,
        suppressionReason: result.entry.reason,
        source: result.entry.source,
        occurredAt: result.entry.occurredAt.toISOString(),
        requiredApproval: needsApproval,
      },
    });

    return NextResponse.json({
      removed: true,
      // Said plainly, because the opposite assumption is the expensive one:
      // our list is not the provider's, and Resend's is account-wide (§5.3.1).
      providerListUnchanged: true,
    });
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    return NextResponse.json(
      { error: "Failed to update the suppression list." },
      { status: 500 }
    );
  }
}
