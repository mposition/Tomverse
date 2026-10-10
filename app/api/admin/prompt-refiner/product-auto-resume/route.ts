export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from
  "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from
  "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { resumePromptRefinerProductAuto } from
  "@/lib/promptRefinerProductReleaseStore";
import { PROMPT_REFINER_PRODUCT_AUTO_STOP_REASONS } from
  "@/lib/promptRefinerProductOperationalGuard";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const schema = z.object({
  expectedGeneration: z.number().int().min(1).max(2_147_483_647),
  expectedReasonCode: z.enum(PROMPT_REFINER_PRODUCT_AUTO_STOP_REASONS),
  expectedPauseAuditLogId: z.string().min(1).max(128),
  confirmation: z.literal("RESUME_REFINER_PRODUCT_AUTO_AFTER_OPERATOR_REVIEW"),
}).strict();

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return Response.json({ error: "Not found." }, { status: 404, headers });
    }
    if (getAdminRole(session) !== "owner" || !hasValidMutationOrigin(request)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers });
    }
    try {
      await assertRecentAdminAuthentication(session);
    } catch (error) {
      if (isAdminReauthenticationError(error)) {
        return Response.json({ code: "ADMIN_REAUTHENTICATION_REQUIRED" },
          { status: 428, headers });
      }
      throw error;
    }
    if (process.env.PROMPT_REFINER_PRODUCT_AUTO_RESUME_WRITE_ENABLED !== "1") {
      return Response.json({ code: "PROMPT_REFINER_PRODUCT_AUTO_RESUME_WRITE_DISABLED" },
        { status: 409, headers });
    }
    const body = await readLimitedJson(request, 1024, schema);
    await consumeApiRateLimit(request, session.user.id,
      "admin-prompt-refiner-product-auto-resume", { minute: 2, day: 8 });
    const result = await resumePromptRefinerProductAuto({ session, request,
      expectedGeneration: body.expectedGeneration,
      expectedReasonCode: body.expectedReasonCode,
      expectedPauseAuditLogId: body.expectedPauseAuditLogId });
    return Response.json(result, { status: 201, headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    if (error instanceof Error && error.message.startsWith(
      "prompt_refiner_product_auto_resume_")) {
      return Response.json({ code: "PROMPT_REFINER_PRODUCT_AUTO_RESUME_REFUSED",
        retryAuthorized: false, humanReviewRequired: true },
      { status: 409, headers });
    }
    return Response.json({ code: "PROMPT_REFINER_PRODUCT_AUTO_RESUME_OUTCOME_UNKNOWN",
      retryAuthorized: false, humanReviewRequired: true },
    { status: 503, headers });
  }
}
