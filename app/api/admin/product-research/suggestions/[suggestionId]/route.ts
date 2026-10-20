export const dynamic = "force-dynamic";

import type { Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedText } from "@/lib/apiSecurity";
import {
  AMUX_V4_IDEA_READBACK_ENV,
  AMUX_V4_IDEA_SUBMISSION_ENV,
  ideaSubmissionReadBackPermitted,
  ideaSubmissionWritePermitted,
  inspectAmuxIdeaSubmission,
  isAmuxIdeaRequestId,
} from "@/lib/amux/ideaSubmissionCore";
import { IdeaSubmissionError, readIdeaSubmissionRequest, submitIdea } from "@/lib/amux/ideaSubmissionService";
import { authOptions } from "@/lib/auth";
import { suggestionIdeaText } from "@/lib/productResearchScoutCore";
import { closeSuggestion, readSuggestion } from "@/lib/productResearchScoutStore";

// The operator's two actions on a Scout suggestion
// (docs/policy/product-research-agent.md §10):
//
//   { "action": "dismiss" }                      owner or ops
//   { "action": "send", "requestId": "<uuid>" }  owner
//
// Sending makes an AMUX idea from the suggestion through the same v4 path the
// idea form uses -- its gates, its content scan, its audit -- and then marks
// the suggestion sent. The request id comes from the browser and is kept per
// suggestion, so a click whose answer was lost is read back by that id rather
// than submitted twice.

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });

const admin = async (roles: readonly string[]): Promise<Session | NextResponse> => {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) return json({ error: "Not found." }, 404);
  if (!roles.includes(getAdminRole(session) ?? "")) return json({ error: "Forbidden." }, 403);
  try {
    await assertRecentAdminAuthentication(session);
  } catch (error) {
    if (isAdminReauthenticationError(error)) return json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" }, 428);
    throw error;
  }
  return session;
};

const failure = (error: unknown): Response => {
  if (error instanceof IdeaSubmissionError) {
    return json({ error: error.code, ...(error.ideaId ? { ideaId: error.ideaId } : {}) }, error.status);
  }
  const approval = adminApprovalErrorResponse(error);
  if (approval) return approval;
  const security = apiSecurityResponse(error);
  if (security) return security;
  console.error(JSON.stringify({ event: "product_research_suggestion_action_failed" }));
  return json({ error: "action_failed" }, 500);
};

export async function POST(request: Request, { params }: { params: Promise<{ suggestionId: string }> }) {
  try {
    const { suggestionId } = await params;
    let body: { action?: unknown; requestId?: unknown };
    try {
      body = JSON.parse(await readLimitedText(request, 2_000));
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    if (body.action !== "dismiss" && body.action !== "send") return json({ error: "invalid_action" }, 400);

    const session = await admin(body.action === "send" ? ["owner"] : ["owner", "ops"]);
    if (session instanceof NextResponse) return session;

    const suggestion = await readSuggestion(suggestionId);
    if (!suggestion) return json({ error: "not_found" }, 404);
    if (suggestion.status !== "open") {
      return json({ status: suggestion.status, amuxIdeaId: suggestion.amuxIdeaId });
    }

    if (body.action === "dismiss") {
      const closed = await closeSuggestion({ session, request, id: suggestionId, next: { status: "dismissed" } });
      return json({ status: closed ? "dismissed" : "unchanged" });
    }

    if (typeof body.requestId !== "string" || !isAmuxIdeaRequestId(body.requestId)) {
      return json({ error: "invalid_request_id" }, 400);
    }
    if (!ideaSubmissionWritePermitted(process.env[AMUX_V4_IDEA_SUBMISSION_ENV]) ||
        !ideaSubmissionReadBackPermitted(process.env[AMUX_V4_IDEA_READBACK_ENV])) {
      return json({ error: "amux_submission_disabled" }, 503);
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-product-research-suggestion-send", { minute: 5, day: 50 });

    // A lost answer to an earlier click: the idea may already exist.
    const earlier = await readIdeaSubmissionRequest(session, body.requestId);
    let ideaId: string;
    if (earlier.status === "committed") {
      ideaId = earlier.ideaId;
    } else if (earlier.status === "partial") {
      return json({ error: "idea_partial", ideaId: earlier.ideaId }, 409);
    } else {
      const inspected = inspectAmuxIdeaSubmission(JSON.stringify({
        version: 1,
        requestId: body.requestId,
        input: { version: 1, idea: suggestionIdeaText(suggestion), repositories: [], pullRequests: [] },
      }));
      if (!inspected.ok) return json({ error: inspected.code }, 400);
      ideaId = (await submitIdea({ session, request, inspected })).ideaId;
    }
    const closed = await closeSuggestion({ session, request, id: suggestionId, next: { status: "sent", amuxIdeaId: ideaId } });
    return json({ status: closed ? "sent" : "unchanged", amuxIdeaId: ideaId });
  } catch (error) {
    return failure(error);
  }
}
