export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { ideaSendPath } from "@/lib/amux/ideaSendPath";
import { amuxIdeaSessionPrewriteStatus } from "@/lib/amux/ideaSessionSubmissionCore";
import { AmuxIdeaSessionSubmissionError } from "@/lib/amux/ideaSessionSubmissionService";
import { AMUX_V4_IDEA_READBACK_ENV, AMUX_V4_IDEA_SUBMISSION_ENV, ideaSubmissionReadBackPermitted, ideaSubmissionWritePermitted } from "@/lib/amux/ideaSubmissionCore";
import { IdeaSubmissionError } from "@/lib/amux/ideaSubmissionService";
import { authOptions } from "@/lib/auth";
import { CI_ADVICE_ID, ciAdviceWorkBrief } from "@/lib/qaReleaseCiAdviceActionsCore";
import { changeCiAdviceStatus, readCiAdviceItem, reserveCiAdviceSend } from "@/lib/qaReleaseCiAdviceStore";
import { suggestionSendRequestId } from "@/lib/productResearchScoutCore";
import { sendScoutSuggestion } from "@/lib/productResearchScoutSend";
import { getPublicAppOrigin } from "@/lib/publicUrl";

const bodySchema = z.object({ action: z.enum(["complete", "dismiss", "send"]) }).strict();
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export async function POST(request: Request, { params }: { params: Promise<{ suggestionId: string }> }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) return json({ error: "Not found." }, 404);
    const body = await readLimitedJson(request, 1000, bodySchema);
    const role = getAdminRole(session);
    if (body.action === "send" ? role !== "owner" : role !== "owner" && role !== "ops") return json({ error: "Forbidden." }, 403);
    await assertRecentAdminAuthentication(session);
    const { suggestionId: id } = await params;
    if (!CI_ADVICE_ID.test(id)) return json({ error: "invalid_id" }, 400);
    const item = await readCiAdviceItem(id);
    if (!item) return json({ error: "not_found" }, 404);
    await consumeApiRateLimit(request, session.user.id, "admin-ci-advice-action", { minute: 5, day: 50 });
    const operator = { session, request, id };
    if (body.action !== "send") {
      const updated = await changeCiAdviceStatus({ ...operator, status: body.action === "complete" ? "completed" : "dismissed" });
      return updated ? json({ item: updated }) : json({ error: "suggestion_changed" }, 409);
    }
    if (item.status === "sent") return json({ item });
    if (!ideaSubmissionWritePermitted(process.env[AMUX_V4_IDEA_SUBMISSION_ENV]) ||
      !ideaSubmissionReadBackPermitted(process.env[AMUX_V4_IDEA_READBACK_ENV])) return json({ error: "amux_submission_disabled" }, 503);
    const path = await ideaSendPath({ session, request, requestId: suggestionSendRequestId(`qa-ci:${id}`),
      idea: ciAdviceWorkBrief(item, getPublicAppOrigin(request)), sessionDisplay: "CI improvement suggestion" });
    if (!path.ok) return json({ error: path.code }, path.status);
    if (!(await reserveCiAdviceSend(operator))) return json({ error: "suggestion_not_sendable" }, 409);
    const result = await sendScoutSuggestion({ readBack: path.readBack, submit: path.submit, isAlreadySeen: path.isAlreadySeen,
      close: async (ideaId) => (await changeCiAdviceStatus({ ...operator, status: "sent", ideaId })) !== null });
    if (result.kind === "partial") return json({ error: "idea_partial", ideaId: result.ideaId }, 409);
    if (result.kind === "in_progress") return json({ error: "idea_in_progress" }, 409);
    const updated = await readCiAdviceItem(id);
    return result.closed ? json({ item: updated }) : json({ error: "suggestion_changed", ideaId: result.ideaId }, 409);
  } catch (error) {
    if (isAdminReauthenticationError(error)) return json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" }, 428);
    if (error instanceof AmuxIdeaSessionSubmissionError) {
      const status = amuxIdeaSessionPrewriteStatus(error.code);
      return json({ error: status ? error.code : "outcome_unknown" }, status ?? 503);
    }
    if (error instanceof IdeaSubmissionError) return json({ error: error.code }, error.status);
    const approval = adminApprovalErrorResponse(error);
    if (approval) return approval;
    const security = apiSecurityResponse(error);
    if (security) return security;
    console.error(JSON.stringify({ event: "ci_advice_action_failed" }));
    return json({ error: "action_failed" }, 500);
  }
}
