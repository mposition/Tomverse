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
import { hasValidMutationOrigin } from "@/lib/requestOrigin";
import { preparePromptRefinerVnextOneShotStageBinding } from
  "@/lib/promptRefinerVnextOneShotStageAdmission";
import { createPromptRefinerVnextOneShotV4Stage } from
  "@/lib/promptRefinerVnextOneShotV4StageWriter";

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const deploymentId = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const requestSchema = z.object({
  sourceCommitSha: sha,
  sourceManifestDigest: digest,
  runnerDigest: digest,
  manifestRoot: digest,
  runtimeDeploymentId: deploymentId,
  runtimeCommitSha: sha,
  pricePinDigest: digest,
  confirmation: z.literal("APPROVE_VNEXT_ONE_SHOT_B03O_RECOVERY_V4_AND_CLOSE_V3"),
}).strict();

/** Owner-only stage recording; no run approval, dispatch, or provider call. */
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
      "admin-prompt-refiner-vnext-stage-approval", { minute: 1, day: 3 });
    // Deployment of this code never enables a holdout or paid path by itself.
    if (process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_STAGE_WRITE_ENABLED !== "1") {
      return NextResponse.json({ code: "STAGE_WRITE_DISABLED" },
        { status: 409, headers });
    }
    const body = await readLimitedJson(request, 2 * 1024, requestSchema);
    const binding = await preparePromptRefinerVnextOneShotStageBinding(body);
    const result = await createPromptRefinerVnextOneShotV4Stage({
      session, request, binding,
    });
    return NextResponse.json({
      stageId: result.stageId,
      stageApprovalAuditLogId: result.stageApprovalAuditLogId,
      slotCount: result.slotCount,
      dispatchAuthorized: false,
    }, { status: 201, headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    // Neither the root nor the runner digest nor an infrastructure failure is
    // ever echoed or logged by the route.
    return NextResponse.json({ code: "STAGE_APPROVAL_OUTCOME_UNKNOWN",
      retryAuthorized: false, humanReviewRequired: true },
      { status: 503, headers });
  }
}
