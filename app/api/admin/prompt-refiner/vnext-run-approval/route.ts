export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import {
  assertRecentAdminAuthentication,
  isAdminReauthenticationError,
} from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from
  "@/lib/apiSecurity";
import { approvePromptRefinerVnextOneShotRun } from
  "@/lib/promptRefinerVnextOneShotRunApproval";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const DEFINITE_REFUSALS = new Set([
  "vnext_one_shot_run_approval_context_invalid",
  "vnext_one_shot_run_custody_pin_unavailable",
  "vnext_one_shot_run_stage_not_ready",
  "vnext_one_shot_run_binding_mismatch",
  "vnext_one_shot_price_mismatch",
]);

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const deploymentId = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const V5 = "prompt-refiner-vnext-one-shot-v5";
const V4_CONFIRMATION = "APPROVE_VNEXT_ONE_SHOT_RUN_80_SLOTS";
const V5_CONFIRMATION = "APPROVE_VNEXT_ONE_SHOT_NEW_V5_RUN_80_SLOTS";
const requestSchema = z.object({
  stageId: z.literal(V5).optional(),
  stageApprovalAuditLogId: z.string().min(1).max(128),
  sourceCommitSha: sha,
  sourceManifestDigest: digest,
  runnerDigest: digest,
  manifestRoot: digest,
  runtimeDeploymentId: deploymentId,
  runtimeCommitSha: sha,
  pricePinDigest: digest,
  confirmation: z.enum([V4_CONFIRMATION, V5_CONFIRMATION]),
}).strict().refine((value) => value.stageId === V5
  ? value.confirmation === V5_CONFIRMATION
  : value.confirmation === V4_CONFIRMATION);

/** Separate owner approval after stage; never dispatches or calls a provider. */
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404, headers });
    }
    if (getAdminRole(session) !== "owner") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403, headers });
    }
    try {
      await assertRecentAdminAuthentication(session);
    } catch (error) {
      if (isAdminReauthenticationError(error)) {
        return NextResponse.json({ code: "ADMIN_REAUTHENTICATION_REQUIRED" },
          { status: 428, headers });
      }
      throw error;
    }
    if (!hasValidMutationOrigin(request)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403, headers });
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-prompt-refiner-vnext-run-approval", { minute: 1, day: 3 });
    if (process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUN_WRITE_ENABLED !== "1") {
      return NextResponse.json({ code: "RUN_WRITE_DISABLED" },
        { status: 409, headers });
    }
    const body = await readLimitedJson(request, 2 * 1024, requestSchema);
    const { confirmation: _confirmation, stageId, ...expected } = body;
    void _confirmation;
    const result = await approvePromptRefinerVnextOneShotRun({
      session, request, expected, stageId,
    });
    return NextResponse.json({
      stageId: result.stageId,
      runApprovalAuditLogId: result.runApprovalAuditLogId,
      dispatchAuthorized: false,
    }, { status: 201, headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    if (error instanceof Error && DEFINITE_REFUSALS.has(error.message)) {
      return NextResponse.json({ code: "RUN_APPROVAL_REFUSED",
        retryAuthorized: false }, { status: 409, headers });
    }
    return NextResponse.json({ code: "RUN_APPROVAL_OUTCOME_UNKNOWN",
      retryAuthorized: false, humanReviewRequired: true },
      { status: 503, headers });
  }
}
