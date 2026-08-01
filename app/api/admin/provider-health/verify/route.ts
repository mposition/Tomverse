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
import {
  MONITORED_PROVIDERS,
  PROVIDER_DISPLAY_NAMES,
} from "@/lib/providerMonitoring";
import {
  claimVerificationSlot,
  getProviderVerificationSummaries,
  recordVerificationResult,
} from "@/lib/providerRecovery";
import {
  getVerificationModelFor,
  recordVerificationUsage,
  runProviderVerification,
} from "@/lib/providerVerification";

// STG-R002: administrator-triggered live provider verification.
//
// This route spends real provider money on purpose, so every guard the admin
// console already has applies at once: admin session, ops:write, per-actor
// rate limit, per-provider cooldown, strict body schema, and an audit entry
// for the attempt as well as for its outcome. CSRF is enforced ahead of this
// handler by the mutation-origin check in proxy.ts.
//
// It deliberately does *not* change any provider health state on its own. A
// successful verification is evidence; clearing a provider's block is a
// separate, separately audited action (../recover).

const providers = Object.keys(PROVIDER_DISPLAY_NAMES) as [
  AiProvider,
  ...AiProvider[],
];

const verifySchema = z
  .object({
    provider: z.enum(providers),
    // Explicit acknowledgement that this call bills the provider. Required, so
    // a stray or replayed request cannot spend money by accident, and so the
    // confirmation the UI shows is enforced server-side rather than trusted.
    acknowledgeProviderCost: z.literal(true),
  })
  .strict();

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(
      req,
      session.user.id,
      "admin-provider-verification-read",
      { minute: 40, day: 1_000 }
    );

    const summaries = await getProviderVerificationSummaries(MONITORED_PROVIDERS);
    return NextResponse.json(
      { providers: Object.fromEntries(summaries) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load provider verification history:", error);
    return NextResponse.json(
      { error: "Failed to load provider verification history." },
      { status: 500 }
    );
  }
}

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
      "admin-provider-verification-write",
      { minute: 5, day: 100 }
    );

    const body = await readLimitedJson(req, 2 * 1024, verifySchema);
    const provider = body.provider;
    const model = getVerificationModelFor(provider);

    // Claimed before the provider is called, so two operators (or one
    // double-click) contend on a row in the database rather than both
    // spending money. The claim also *is* the cooldown record.
    const claim = await claimVerificationSlot({
      provider,
      modelId: model?.id ?? null,
      traceId,
      actorId: session.user.id,
      actorEmail: session.user.email || null,
    });
    if (!claim.ok) {
      return NextResponse.json(
        {
          error:
            claim.reason === "cooldown"
              ? "A verification for this provider ran too recently. Wait for the cooldown to elapse."
              : "A verification for this provider is already running.",
          reason: claim.reason,
          retryAfterSeconds: claim.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": String(claim.retryAfterSeconds) },
        }
      );
    }

    await writeAdminAuditLog({
      session,
      request: req,
      action: "provider_verification_started",
      targetType: "Provider",
      targetId: provider,
      summary: `Started a live verification call for ${provider}.`,
      metadata: {
        provider,
        verificationModelId: model?.id ?? null,
        checkId: claim.checkId,
        traceId,
      },
    });

    const result = await runProviderVerification(provider);
    await recordVerificationResult({ checkId: claim.checkId, result });
    // Cost bookkeeping must never change the verdict an operator acts on.
    await recordVerificationUsage(result).catch((error) => {
      console.warn("Provider verification usage bookkeeping failed:", {
        traceId,
        provider,
        error,
      });
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action:
        result.status === "success"
          ? "provider_verification_succeeded"
          : "provider_verification_failed",
      targetType: "Provider",
      targetId: provider,
      summary: `Live verification for ${provider} returned ${result.status}.`,
      metadata: {
        provider,
        checkId: claim.checkId,
        status: result.status,
        verificationModelId: result.modelId,
        // Sanitized code and coarse label only -- never the raw provider
        // response, the request Authorization header, or any prompt content.
        diagnosticCode: result.diagnosticCode,
        errorClassification: result.errorClassification,
        latencyMs: result.latencyMs,
        traceId,
      },
    });

    return NextResponse.json(
      {
        check: {
          id: claim.checkId,
          provider,
          status: result.status,
          modelId: result.modelId,
          latencyMs: result.latencyMs,
          diagnosticCode: result.diagnosticCode,
          errorClassification: result.errorClassification,
          message: result.message,
          checkedAt: new Date().toISOString(),
          recoveryApplied: false,
        },
        traceId,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Provider verification failed:", { traceId, error });
    return NextResponse.json(
      { error: "Provider verification failed.", traceId },
      { status: 500 }
    );
  }
}
