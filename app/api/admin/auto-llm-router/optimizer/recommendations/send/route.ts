export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { ideaSendPath } from "@/lib/amux/ideaSendPath";
import { amuxIdeaSessionPrewriteStatus } from "@/lib/amux/ideaSessionSubmissionCore";
import { AmuxIdeaSessionSubmissionError } from "@/lib/amux/ideaSessionSubmissionService";
import {
  AMUX_V4_IDEA_READBACK_ENV,
  AMUX_V4_IDEA_SUBMISSION_ENV,
  ideaSubmissionReadBackPermitted,
  ideaSubmissionWritePermitted,
  isAmuxIdeaRequestId,
} from "@/lib/amux/ideaSubmissionCore";
import { IdeaSubmissionError } from "@/lib/amux/ideaSubmissionService";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  markRecommendationSentToAmux,
  readRecommendationForSend,
  reserveRecommendationForAmux,
} from "@/lib/autoRouterRecommendations";
import { recommendationIdeaText, recommendationSendRequestId } from "@/lib/autoRouterRecommendationSendCore";
import { isRecommendationSendable, RECOMMENDATION_SENT_STATUS } from "@/lib/autoRouterRecommendationsCore";
import { sendScoutSuggestion } from "@/lib/productResearchScoutSend";
import { getPublicAppOrigin } from "@/lib/publicUrl";

// Admin › Routing: an owner sends a code or setting recommendation to AMUX as an
// idea, the same way the Scout console sends a suggestion
// (app/api/admin/product-research/suggestions/[suggestionId]/route.ts): through
// the door the idea form uses (lib/amux/ideaSendPath.ts), its gates, its content
// scan and its audit. The text and the request id are derived here from the
// stored report, so a lost answer, a second tab or a second owner name the same
// request and AMUX takes it once.

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });

const bodySchema = z
  .object({ cycleId: z.string().trim().min(1).max(64), index: z.number().int().min(0).max(63) })
  .strict();

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) return json({ error: "Not found." }, 404);
    if (getAdminRole(session) !== "owner") return json({ error: "Forbidden." }, 403);
    try {
      await assertRecentAdminAuthentication(session);
    } catch (error) {
      if (isAdminReauthenticationError(error)) return json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" }, 428);
      throw error;
    }
    const body = await readLimitedJson(request, 1024, bodySchema);

    const found = await readRecommendationForSend(body);
    if (!found) return json({ error: "not_found" }, 404);
    const { recommendation } = found;
    if (recommendation.status === RECOMMENDATION_SENT_STATUS) {
      return json({ status: "sent", amuxIdeaId: recommendation.amuxIdeaId });
    }
    if (!isRecommendationSendable(recommendation.status)) return json({ error: "not_sendable", code: "not_sendable" }, 409);

    const requestId = recommendationSendRequestId(body.cycleId, body.index);
    if (!isAmuxIdeaRequestId(requestId)) return json({ error: "invalid_request_id" }, 500);
    if (
      !ideaSubmissionWritePermitted(process.env[AMUX_V4_IDEA_SUBMISSION_ENV]) ||
      !ideaSubmissionReadBackPermitted(process.env[AMUX_V4_IDEA_READBACK_ENV])
    ) {
      return json({ error: "amux_submission_disabled" }, 503);
    }
    await consumeApiRateLimit(request, session.user.id, "admin-auto-router-recommendation-send", { minute: 5, day: 50 });

    const path = await ideaSendPath({
      session,
      request,
      requestId,
      idea: recommendationIdeaText({
        recommendation: { kind: recommendation.kind, text: recommendation.text },
        findings: found.findings,
        cycle: { id: body.cycleId, createdAt: found.createdAt },
        origin: getPublicAppOrigin(request),
      }),
      sessionDisplay: "Auto router recommendation",
    });
    if (!path.ok) return json({ error: path.code }, path.status);

    // Before anything reaches AMUX, under the lock the coding agent claims under.
    if (!(await reserveRecommendationForAmux({ session, request }, body))) {
      return json({ error: "not_sendable", code: "not_sendable" }, 409);
    }

    const result = await sendScoutSuggestion({
      readBack: path.readBack,
      submit: path.submit,
      isAlreadySeen: path.isAlreadySeen,
      close: (ideaId) => markRecommendationSentToAmux({ session, request }, { ...body, ideaId }),
    });
    if (result.kind === "partial") return json({ error: "idea_partial", code: "idea_partial", ideaId: result.ideaId }, 409);
    if (result.kind === "in_progress") return json({ error: "idea_in_progress", code: "idea_in_progress" }, 409);
    return json({ status: result.closed ? "sent" : "unchanged", amuxIdeaId: result.ideaId });
  } catch (error) {
    if (error instanceof AmuxIdeaSessionSubmissionError) {
      // Anything but a refusal before the write is finished by sending again,
      // which reads the idea back by its request id.
      const status = amuxIdeaSessionPrewriteStatus(error.code);
      const code = status ? error.code : "outcome_unknown";
      return json({ error: code, code }, status ?? 503);
    }
    if (error instanceof IdeaSubmissionError) {
      return json({ error: error.code, code: error.code, ...(error.ideaId ? { ideaId: error.ideaId } : {}) }, error.status);
    }
    const approval = adminApprovalErrorResponse(error);
    if (approval) return approval;
    const security = apiSecurityResponse(error);
    if (security) return security;
    console.error(JSON.stringify({ event: "auto_router_recommendation_send_failed" }));
    return json({ error: "action_failed" }, 500);
  }
}
