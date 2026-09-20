export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
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
import { suppressionRemovalProblem } from "@/lib/adminEmailDeliveryFilters";
import {
  GLOBAL_PURPOSE_KEY,
  activeCausesForSelector,
  liftSuppressionCauses,
  normalizeSuppressionAddress,
  recordSuppression,
} from "@/lib/emailSuppression";
import { readSuppressionAuthority } from "@/lib/emailSuppressionAuthority";

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

/** A lift refused inside an approved operation; see the causes-mode branch. */
class SuppressionLiftRefused extends Error {
  constructor(
    readonly refusal: "not_found" | "unliftable" | "authority_changed" | "approval_stale"
  ) {
    super(`Suppression lift refused: ${refusal}`);
    this.name = "SuppressionLiftRefused";
  }
}

/** The caller's Idempotency-Key when it is a sane token, otherwise a fresh id. */
const adminIdempotencyKey = (req: Request) => {
  const header = req.headers.get("idempotency-key")?.trim();
  return header && /^[A-Za-z0-9._:-]{8,128}$/.test(header) ? header : randomUUID();
};

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
        // A retried request with the same Idempotency-Key records one cause;
        // without the header each request is its own event.
        sourceEventKey: `admin:${adminIdempotencyKey(req)}`,
      });

      await writeAdminAuditLog({
        session,
        request: req,
        action: "email_suppression.added",
        targetType: "SuppressionEntry",
        targetId: result.id ?? emailAddress,
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

    // Once causes decide, a lift releases causes by the release matrix and the
    // approval is bound to the exact set of active causes it was asked for
    // (docs/policy/email-product-news-redesign-draft.md, section 7.4).
    if ((await readSuppressionAuthority()) === "causes") {
      const active = await activeCausesForSelector(body.id);
      if (!active) {
        return NextResponse.json({ error: "Not found." }, { status: 404 });
      }
      const releaseAudit =
        (evidenceKind: string) => (tx: Parameters<typeof writeAdminAuditLog>[0]["tx"]) =>
          writeAdminAuditLog({
            session,
            request: req,
            action: "email_suppression.removed",
            targetType: "SuppressionCause",
            targetId: body.id,
            summary: `Lifted suppression causes on ${active.selector.emailAddress}.`,
            metadata: {
              reason: body.reason,
              emailAddress: active.selector.emailAddress,
              scope: active.selector.scope,
              purposeKey: active.selector.purposeKey,
              causeIds: active.causeIds,
              causeReasons: active.reasons,
              evidenceKind,
            },
            tx,
          });

      // A refused lift inside an approved operation is thrown, not returned, so
      // the approval path records it as a failed execution rather than as one
      // that ran; outside that path the result is handled directly.
      let lifted: Awaited<ReturnType<typeof liftSuppressionCauses>>;
      try {
        lifted = active.needsApproval
          ? await runWithAdminApproval(
              {
                session,
                request: req,
                action: "email_suppression.remove",
                targetType: "SuppressionCause",
                targetId: body.id,
                // The cause ids are part of what is approved: a cause added after
                // the request is a different approval.
                payload: { id: body.id, causeIds: active.causeIds },
                reason: body.reason,
              },
              async (context) => {
                const outcome = await liftSuppressionCauses({
                  causeId: body.id,
                  approvedCauseIds: active.causeIds,
                  action: "approved_admin",
                  evidence: context.approvalId
                    ? {
                        kind: "dual_approval",
                        approvalId: context.approvalId,
                        authorizationAuditLogId: context.authorizationAuditLogId,
                      }
                    : { kind: "sole_admin", authorizationAuditLogId: context.authorizationAuditLogId },
                  writeReleaseAudit: releaseAudit(context.approvalId ? "dual_approval" : "sole_admin"),
                });
                if (!outcome.removed) throw new SuppressionLiftRefused(outcome.refusal);
                return outcome;
              }
            )
          : await liftSuppressionCauses({
              causeId: body.id,
              approvedCauseIds: active.causeIds,
              action: "admin",
              evidence: { kind: "admin" },
              writeReleaseAudit: releaseAudit("admin"),
            });
      } catch (error) {
        if (!(error instanceof SuppressionLiftRefused)) throw error;
        lifted = { removed: false, refusal: error.refusal };
      }

      if (!lifted.removed) {
        const status =
          lifted.refusal === "not_found" ? 404 : 409;
        const error =
          lifted.refusal === "authority_changed"
            ? "Suppression decisions changed over while this was in progress. Try again."
            : lifted.refusal === "approval_stale"
            ? "The suppression changed after this was asked for. Review it again."
            : lifted.refusal === "unliftable"
              ? "Nothing here can be lifted from this screen; a privacy request is lifted by the privacy process that created it."
              : "Not found.";
        return NextResponse.json({ error, code: lifted.refusal }, { status });
      }
      return NextResponse.json({
        removed: lifted.remaining.length === 0,
        released: lifted.released,
        remaining: lifted.remaining,
        providerListUnchanged: true,
      });
    }

    // Entry authority, and the console no longer speaks it.
    //
    // The lift above is reached by a cause id, because that is what the list
    // hands out now (docs/policy/email-product-news-redesign-draft.md, section
    // 7.4). An entry-authority lift would have to resolve the same id as a
    // `SuppressionEntry` row, find nothing, and answer 404 -- which reads as
    // "that suppression is gone" when what happened is that the setting was
    // moved back below this build's floor.
    //
    // So it says which of those it is. Production has read causes since
    // 2026-09-17 and the rollback floor for this deploy is the causes cutover;
    // an environment that finds itself here is one whose setting went backwards
    // and needs it put back, not an operator who should try again.
    return NextResponse.json(
      {
        error:
          "This build's suppression console lists causes, and the suppression setting is back on entries. Nothing was changed. Put the setting back to causes before lifting anything here.",
        code: "authority_changed",
      },
      { status: 409 }
    );
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
