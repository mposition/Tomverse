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

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const deploymentId = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const requestSchema = z.object({
  stageApprovalAuditLogId: z.string().min(1).max(128),
  sourceCommitSha: sha,
  sourceManifestDigest: digest,
  runnerDigest: digest,
  manifestRoot: digest,
  runtimeDeploymentId: deploymentId,
  runtimeCommitSha: sha,
  pricePinDigest: digest,
  confirmation: z.literal("APPROVE_VNEXT_ONE_SHOT_RUN_80_SLOTS"),
}).strict();

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
    const { confirmation: _confirmation, ...expected } = body;
    void _confirmation;
    const result = await approvePromptRefinerVnextOneShotRun({
      session, request, expected,
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
    return NextResponse.json({ code: "RUN_APPROVAL_UNAVAILABLE" },
      { status: 503, headers });
  }
}
