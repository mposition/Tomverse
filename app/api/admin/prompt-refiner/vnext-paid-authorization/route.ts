export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from
  "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from
  "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { approvePromptRefinerVnextOneShotPaidDispatch } from
  "@/lib/promptRefinerVnextOneShotPaidAuthorization";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const deploymentId = z.string().uuid();
const schema = z.object({
  stageApprovalAuditLogId: z.string().min(1).max(128),
  runApprovalAuditLogId: z.string().min(1).max(128),
  shadowAuditLogId: z.string().min(1).max(128),
  sourceCommitSha: sha,
  sourceManifestDigest: digest,
  runnerDigest: digest,
  manifestRoot: digest,
  runtimeDeploymentId: deploymentId,
  runtimeCommitSha: sha,
  pricePinDigest: digest,
  confirmation: z.literal("AUTHORIZE_VNEXT_ONE_SHOT_V3_PAID_DISPATCH_AFTER_B06"),
}).strict();

/** Future, separate owner approval. B06 does not invoke this route. */
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
      "admin-prompt-refiner-vnext-paid-authorization", { minute: 1, day: 1 });
    if (process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_PAID_APPROVAL_WRITE_ENABLED !== "1") {
      return NextResponse.json({ code: "PAID_APPROVAL_WRITE_DISABLED" },
        { status: 409, headers });
    }
    const body = await readLimitedJson(request, 2 * 1024, schema);
    const { confirmation: _confirmation, ...expected } = body;
    void _confirmation;
    const result = await approvePromptRefinerVnextOneShotPaidDispatch({
      session, request, expected,
    });
    return NextResponse.json(result, { status: 201, headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    return NextResponse.json({ code: "PAID_APPROVAL_OUTCOME_UNKNOWN",
      retryAuthorized: false, humanReviewRequired: true },
      { status: 503, headers });
  }
}
