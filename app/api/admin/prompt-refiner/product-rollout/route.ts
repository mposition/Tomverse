export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from
  "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from
  "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { chatRefinerInitialAutoRolloutRequestSchema } from
  "@/lib/chatRefinerInitialAutoReleaseApiContract";
import { setChatRefinerInitialAutoRollout } from
  "@/lib/chatRefinerInitialAutoRolloutStore";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const headers = { "Cache-Control": "private, no-store, max-age=0" };

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
    if (process.env.PROMPT_REFINER_PRODUCT_ROLLOUT_WRITE_ENABLED !== "1") {
      return Response.json({ code: "PROMPT_REFINER_PRODUCT_ROLLOUT_WRITE_DISABLED" },
        { status: 409, headers });
    }
    const body = await readLimitedJson(
      request, 1024, chatRefinerInitialAutoRolloutRequestSchema);
    await consumeApiRateLimit(request, session.user.id,
      "admin-prompt-refiner-product-rollout", { minute: 2, day: 8 });
    const result = await setChatRefinerInitialAutoRollout({ session, request,
      enabled: body.enabled, runtimeCommitSha: body.runtimeCommitSha,
      runtimeDeploymentId: body.runtimeDeploymentId });
    return Response.json(result, { status: 201, headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    if (error instanceof Error &&
        error.message.startsWith("chat_refiner_initial_auto_rollout_")) {
      return Response.json({ code: "PROMPT_REFINER_PRODUCT_ROLLOUT_REFUSED",
        retryAuthorized: false, humanReviewRequired: true },
      { status: 409, headers });
    }
    return Response.json({ code: "PROMPT_REFINER_PRODUCT_ROLLOUT_OUTCOME_UNKNOWN",
      retryAuthorized: false, humanReviewRequired: true },
    { status: 503, headers });
  }
}
