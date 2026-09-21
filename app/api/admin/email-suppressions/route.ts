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
 * **A lift acts on a selector's whole set of active causes and releases the
 * subset its action may.** That is the shape this screen works in, and it is
 * not the shape "three levels, by what the entry says" described. That was
 * written when one merged row stood for the whole suppression: the row had one
 * reason, so the lift had one answer about it.
 *
 * What the reasons decide now is which causes come out.
 *
 *  - `privacy_request` is released by nothing. It is the record of someone
 *    exercising a legal right, and the process entitled to lift it is the
 *    privacy process that created it, not a button here. It no longer refuses
 *    the request, because it is no longer the request: an address holding a
 *    `manual` hold and a `privacy_request` has the hold released and the
 *    privacy request left standing, so the address stays suppressed. Refusing
 *    outright would leave an operator with no way to undo their own hold.
 *  - `hard_bounce` and `complaint` need a second administrator. §13.3 calls
 *    them permanent, and complaints are what a receiver measures a sending
 *    domain by (§14.5) -- the part of this system that recovers slowest. One
 *    of them anywhere in the set is what makes the whole request need approval.
 *  - everything else needs a reason that says something, and an audit entry.
 *
 * So a lift answers with `released` and `remaining` rather than removed or not,
 * and the audit entry names the set (`SuppressionCauseSet`) rather than the
 * handle the operator clicked. The matrix is `releasableBy()` in
 * `lib/emailSuppressionAuthorityCore.ts` and is not restated here.
 *
 * Our own list is not the provider's. Resend's suppression is account- and
 * region-wide (§5.3.1), so lifting a cause here does not lift one there, and
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
  /**
   * `causeSetDigest` from the row the caller was looking at, out of its own GET.
   *
   * Required, and carried in rather than read here. A set the server reads for
   * itself at this instant is approved by definition: a cause added between the
   * listing and the click -- a fresh unsubscribe on an address being lifted for
   * a stale soft bounce -- would be released with nobody having seen it, and we
   * would resume mailing somebody who asked us to stop. Naming what was on the
   * screen is what makes the comparison mean anything.
   *
   * A digest rather than the ids themselves, and this is not a stylistic
   * choice. Causes are append-only and nothing bounds how many a selector
   * accumulates, while the listing returns all of them -- so a request carrying
   * the ids has a ceiling wherever the body limit falls, and past it the
   * selector is visible and permanently unliftable: send them all and the body
   * is refused, send fewer and the set does not match. Sixty-four hex
   * characters do not move.
   */
  causeSetDigest: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/, "a sha-256 digest in lower-case hex"),
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
      if (!active.found) {
        return NextResponse.json({ error: "Not found." }, { status: 404 });
      }

      // A handle that resolved but is no longer active, and a caller naming a
      // set that is not the live one, are the same situation: the screen this
      // came from is describing a suppression that has changed. Saying "not
      // found" for the first would tell an operator whose page went stale that
      // the suppression they were looking at has vanished.
      //
      // This is the early refusal, and it is not the one that matters: the set
      // is checked again inside the lift's transaction, under the address lock,
      // against the rows that are there at the moment of the release. What this
      // buys is refusing before an approval is asked for.
      if (active.stale || active.digest !== body.causeSetDigest) {
        return NextResponse.json(
          {
            error:
              "The causes on this address changed after it was listed. Look at it again before lifting it.",
            code: "approval_stale",
          },
          { status: 409 }
        );
      }

      // The audited thing is the selector's set of causes, not the row handle.
      //
      // The handle is whichever cause the listing put first, and the release
      // matrix does not release by that: an operator lifting an address that
      // holds a `manual` and a `privacy_request` releases the manual and keeps
      // the privacy request, while the newest cause -- the handle -- is the
      // privacy request. Naming it as the target writes an immutable record
      // that reads as though the privacy request had been removed.
      //
      // So the target is the set, named by its digest, and the metadata says
      // what was actually released and what stayed. Those come from inside the
      // transaction rather than from the read above, because the decision is
      // made there.
      const releaseAudit =
        (evidence: {
          kind: string;
          approvalId?: string;
          authorizationAuditLogId?: string;
        }) =>
        (
          tx: Parameters<typeof writeAdminAuditLog>[0]["tx"],
          outcome: {
            released: Array<{ id: string; reason: string }>;
            remaining: Array<{ id: string; reason: string }>;
          }
        ) =>
          writeAdminAuditLog({
            session,
            request: req,
            action: "email_suppression.removed",
            targetType: "SuppressionCauseSet",
            targetId: active.digest,
            summary:
              outcome.remaining.length === 0
                ? `Lifted every active suppression cause on ${active.selector.emailAddress}.`
                : `Lifted ${outcome.released.length} of ${
                    outcome.released.length + outcome.remaining.length
                  } suppression causes on ${active.selector.emailAddress}; ${outcome.remaining
                    .map((cause) => cause.reason)
                    .join(", ")} remain.`,
            metadata: {
              reason: body.reason,
              emailAddress: active.selector.emailAddress,
              scope: active.selector.scope,
              purposeKey: active.selector.purposeKey,
              // The handle is recorded as what it is -- the row the operator
              // acted from -- rather than as the target.
              viaCauseId: body.id,
              causeSetDigest: active.digest,
              releasedCauseIds: outcome.released.map((cause) => cause.id),
              releasedReasons: outcome.released.map((cause) => cause.reason),
              remainingCauseIds: outcome.remaining.map((cause) => cause.id),
              remainingReasons: outcome.remaining.map((cause) => cause.reason),
              // Which authorisation this was, and which one specifically. The
              // kind alone says a second administrator approved it somewhere;
              // the ids say which approval and which authorisation entry, so
              // the release can be followed from this row rather than from the
              // cause's own evidence.
              evidenceKind: evidence.kind,
              approvalId: evidence.approvalId ?? null,
              authorizationAuditLogId: evidence.authorizationAuditLogId ?? null,
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
                targetType: "SuppressionCauseSet",
                targetId: active.digest,
                // The cause ids are part of what is approved: a cause added after
                // the request is a different approval.
                payload: { viaCauseId: body.id, causeSetDigest: body.causeSetDigest },
                reason: body.reason,
              },
              async (context) => {
                const outcome = await liftSuppressionCauses({
                  causeId: body.id,
                  approvedDigest: body.causeSetDigest,
                  action: "approved_admin",
                  evidence: context.approvalId
                    ? {
                        kind: "dual_approval",
                        approvalId: context.approvalId,
                        authorizationAuditLogId: context.authorizationAuditLogId,
                      }
                    : { kind: "sole_admin", authorizationAuditLogId: context.authorizationAuditLogId },
                  writeReleaseAudit: releaseAudit({
                    kind: context.approvalId ? "dual_approval" : "sole_admin",
                    ...(context.approvalId ? { approvalId: context.approvalId } : {}),
                    authorizationAuditLogId: context.authorizationAuditLogId,
                  }),
                });
                if (!outcome.removed) throw new SuppressionLiftRefused(outcome.refusal);
                return outcome;
              }
            )
          : await liftSuppressionCauses({
              causeId: body.id,
              approvedDigest: body.causeSetDigest,
              action: "admin",
              evidence: { kind: "admin" },
              writeReleaseAudit: releaseAudit({ kind: "admin" }),
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
