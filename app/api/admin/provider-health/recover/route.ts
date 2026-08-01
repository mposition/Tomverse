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
import type { AiProvider } from "@/lib/models";
import { PROVIDER_DISPLAY_NAMES } from "@/lib/providerMonitoring";
import { applyVerifiedRecovery } from "@/lib/providerRecovery";

// STG-R002: clears a provider's blocking consecutive-failure counter against a
// successful live verification.
//
// There is deliberately no way to reach this outcome without a verification:
// the request must name the ProviderHealthCheck row that authorises it, and
// lib/providerRecovery.ts re-validates that row inside the same transaction
// that performs the reset. A request body alone can never zero the counter.
//
// What recovery does *not* do: write lastSuccessAt. Clearing the block means
// "stop treating expired failures as current evidence", not "pretend a request
// succeeded". The provider's status afterwards is still derived from real
// evidence -- the verification simply becomes the most recent thing we know.

const providers = Object.keys(PROVIDER_DISPLAY_NAMES) as [
  AiProvider,
  ...AiProvider[],
];

const recoverSchema = z
  .object({
    provider: z.enum(providers),
    /** The successful verification that authorises this recovery. */
    checkId: z.string().trim().min(1).max(64),
  })
  .strict();

const rejectionStatus = (reason: string) =>
  reason === "VERIFICATION_ALREADY_CONSUMED" || reason === "NOT_BLOCKED"
    ? 409
    : 422;

export async function POST(req: Request) {
  const traceId = crypto.randomUUID();
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    await consumeApiRateLimit(
      req,
      session.user.id,
      "admin-provider-recovery-write",
      { minute: 5, day: 100 }
    );

    const body = await readLimitedJson(req, 2 * 1024, recoverSchema);
    const outcome = await applyVerifiedRecovery({
      provider: body.provider,
      checkId: body.checkId,
    });

    if (!outcome.ok) {
      await writeAdminAuditLog({
        session,
        request: req,
        action: "provider_recovery_rejected",
        targetType: "Provider",
        targetId: body.provider,
        summary: `Rejected a recovery for ${body.provider}: ${outcome.reason}.`,
        metadata: {
          provider: body.provider,
          checkId: body.checkId,
          reason: outcome.reason,
          traceId,
        },
      });
      return NextResponse.json(
        { error: outcome.detail, reason: outcome.reason, traceId },
        { status: rejectionStatus(outcome.reason) }
      );
    }

    await writeAdminAuditLog({
      session,
      request: req,
      action: "provider_recovery_succeeded",
      targetType: "Provider",
      targetId: body.provider,
      summary: `Cleared the ${body.provider} failure block against a verified recovery.`,
      metadata: {
        provider: body.provider,
        checkId: body.checkId,
        verifiedAt: outcome.verifiedAt.toISOString(),
        previousConsecutiveFailures: outcome.previousConsecutiveFailures,
        resultingConsecutiveFailures: outcome.resultingConsecutiveFailures,
        // Stated explicitly in the audit trail: recovery never fabricates a
        // traffic success, so this claim is reviewable after the fact.
        lastSuccessAtModified: false,
        traceId,
      },
    });

    return NextResponse.json(
      {
        provider: body.provider,
        previousConsecutiveFailures: outcome.previousConsecutiveFailures,
        resultingConsecutiveFailures: outcome.resultingConsecutiveFailures,
        traceId,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Provider recovery failed:", { traceId, error });
    return NextResponse.json(
      { error: "Provider recovery failed.", traceId },
      { status: 500 }
    );
  }
}
