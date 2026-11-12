export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { ideaSendPath } from "@/lib/amux/ideaSendPath";
import { amuxIdeaSessionPrewriteStatus } from "@/lib/amux/ideaSessionSubmissionCore";
import { AmuxIdeaSessionSubmissionError } from "@/lib/amux/ideaSessionSubmissionService";
import {
  AMUX_V4_IDEA_READBACK_ENV, AMUX_V4_IDEA_SUBMISSION_ENV,
  ideaSubmissionReadBackPermitted, ideaSubmissionWritePermitted,
} from "@/lib/amux/ideaSubmissionCore";
import { IdeaSubmissionError } from "@/lib/amux/ideaSubmissionService";
import { amuxLegacyCardRecreateRequestId } from "@/lib/amux/legacyCardCore";
import { readAmuxExecutionTaskDetail } from "@/lib/amux/adminExecutionRead";
import {
  AmuxLegacyCardOwnerError, assertAmuxLegacyCardOwner, closeAmuxLegacyCardForOwner,
  completeAmuxStoppedCardForOwner, type AmuxLegacyCardCloseResult,
} from "@/lib/amux/legacyCardOwnerService";
import { closeEngineeringOwnerItemsForSettledCard } from "@/lib/amux/ownerSettlementEngineering";
import { authOptions } from "@/lib/auth";
import { sendScoutSuggestion } from "@/lib/productResearchScoutSend";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

// The owner's actions on a card that stopped -- a legacy WORKBOARD card, a
// pre-v22 Task with no recovery path, or any v22 Task stopped in blocked or
// review (lib/amux/legacyCardCore.ts):
//
//   { "action": "recreate", taskId, revision, ownerConfirmed: true }
//     saves the card's assigned work as a new owner idea through the same
//     intake the idea form and the Scout use (lib/amux/ideaSendPath.ts), then
//     closes the card. The request id is derived from the card on the server,
//     so a lost answer or a second tab reads the same idea back.
//   { "action": "close", taskId, revision, ownerConfirmed: true }
//     closes the card without an idea.
//   { "action": "complete", taskId, revision, reason, ownerConfirmed: true }
//     completes a stopped v22 Task as done on the owner's own judgment
//     (owner decision 2026-11-12); the reason is kept in the audit entry.
//
// A card that is still running, already closed or changed since it was shown
// refuses all three, before any idea is saved. After a close or a completion
// the engineering agent's open draft and decision items for the card's runs
// are closed through its own writers (ownerSettlementEngineering.ts).

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });

const body = z.object({
  action: z.enum(["recreate", "close", "complete"]),
  taskId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  revision: z.number().int().min(0).max(2_147_483_647),
  /** Why the owner completes the card; required for "complete", refused otherwise. */
  reason: z.string().trim().min(1).max(500).optional(),
  ownerConfirmed: z.literal(true),
}).strict().refine((value) => (value.action === "complete") === (value.reason !== undefined));

/** The engineering items of a settled card, closed after its transaction; a failure never undoes the settlement. */
async function engineeringItems(session: Parameters<typeof closeEngineeringOwnerItemsForSettledCard>[0]["session"],
  request: Request, taskId: string) {
  try {
    return await closeEngineeringOwnerItemsForSettledCard({ session, request, taskId });
  } catch {
    console.error(JSON.stringify({ event: "amux_owner_settlement_engineering_items_failed" }));
    return null;
  }
}

const closed = (result: AmuxLegacyCardCloseResult) =>
  result.outcome === "closed" ? { closed: true, archivedAt: result.archivedAt,
    alreadyArchived: result.alreadyArchived, escalationsResolved: result.escalationsResolved } :
    { closed: false, reason: result.outcome === "refused" ? result.reason : "not_found" };

function failure(error: unknown): Response {
  if (isAdminReauthenticationError(error)) return json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" }, 428);
  if (error instanceof AmuxLegacyCardOwnerError) {
    return json({ error: error.code }, error.code === "forbidden" ? 403 : 409);
  }
  if (error instanceof AmuxIdeaSessionSubmissionError) {
    const status = amuxIdeaSessionPrewriteStatus(error.code);
    return json({ error: status ? error.code : "outcome_unknown" }, status ?? 503);
  }
  if (error instanceof IdeaSubmissionError) {
    return json({ error: error.code, ...(error.ideaId ? { ideaId: error.ideaId } : {}) }, error.status);
  }
  const security = apiSecurityResponse(error);
  if (security) {
    security.headers.set("Cache-Control", noStore["Cache-Control"]);
    return security;
  }
  console.error(JSON.stringify({ event: "amux_legacy_card_action_failed" }));
  return json({ error: "outcome_unknown" }, 503);
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) return json({ error: "not_found" }, 404);
    if (getAdminRole(session) !== "owner" || !hasValidMutationOrigin(request)) {
      return json({ error: "forbidden" }, 403);
    }
    await assertAmuxLegacyCardOwner(session);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return json({ error: "content_type_refused" }, 415);
    }
    await consumeApiRateLimit(request, session.user.id, "admin-amux-legacy-card-write", { minute: 10, day: 100 });
    const parsed = await readLimitedJson(request, 1_024, body);

    // The same read the card detail shows: its kind, its close refusal and the
    // idea built on the server from the card's readable (for a v4 Task,
    // decrypted) assigned work. The close judges it all again under its lock.
    const detail = await readAmuxExecutionTaskDetail(parsed.taskId);
    if (!detail) return json({ error: "not_found" }, 404);
    const view = detail.legacyCard;
    const refusal = !view ? "not_legacy" : detail.revision !== parsed.revision ? "changed" : view.closeRefusal;
    if (!view || refusal) return json({ error: "not_closable", reason: refusal }, 409);

    if (parsed.action === "complete") {
      if (view.completeRefusal) return json({ error: "not_completable", reason: view.completeRefusal }, 409);
      const result = await completeAmuxStoppedCardForOwner({ session, request, taskId: parsed.taskId,
        revision: parsed.revision, reason: parsed.reason! });
      if (result.outcome !== "completed") {
        return json({ error: "not_completable",
          reason: result.outcome === "refused" ? result.reason : "not_found" }, 409);
      }
      return json({ status: "completed", revision: result.revision,
        escalationsResolved: result.escalationsResolved,
        engineering: await engineeringItems(session, request, parsed.taskId) });
    }

    if (parsed.action === "close") {
      const result = await closeAmuxLegacyCardForOwner({ session, request, taskId: parsed.taskId,
        revision: parsed.revision, ideaId: null });
      if (result.outcome !== "closed") return json({ error: "not_closable", ...closed(result) }, 409);
      return json({ status: "closed", ...closed(result),
        engineering: await engineeringItems(session, request, parsed.taskId) });
    }

    const idea = view.idea;
    if (idea.state !== "ready") return json({ error: "idea_refused", reason: idea.code }, 400);
    if (!ideaSubmissionWritePermitted(process.env[AMUX_V4_IDEA_SUBMISSION_ENV]) ||
        !ideaSubmissionReadBackPermitted(process.env[AMUX_V4_IDEA_READBACK_ENV])) {
      return json({ error: "amux_submission_disabled" }, 503);
    }
    const requestId = amuxLegacyCardRecreateRequestId(parsed.taskId, idea.text);
    const path = await ideaSendPath({ session, request, requestId, idea: idea.text,
      sessionDisplay: view.kind === "workboard" ? "Legacy WORKBOARD card" :
        view.kind === "pre_v22_task" ? "Pre-v22 AMUX Task" : "Stopped AMUX Task" });
    if (!path.ok) return json({ error: "idea_refused", reason: path.code }, path.status);
    const closing: { result: AmuxLegacyCardCloseResult | null } = { result: null };
    const result = await sendScoutSuggestion({ readBack: path.readBack, submit: path.submit,
      isAlreadySeen: path.isAlreadySeen,
      close: async (ideaId) => {
        closing.result = await closeAmuxLegacyCardForOwner({ session, request, taskId: parsed.taskId,
          revision: parsed.revision, ideaId });
        return closing.result.outcome === "closed";
      } });
    if (result.kind === "partial") return json({ error: "idea_partial", ideaId: result.ideaId }, 409);
    if (result.kind === "in_progress") return json({ error: "idea_in_progress" }, 409);
    return json({ status: "recreated", ideaId: result.ideaId, requestId,
      ...(closing.result ? closed(closing.result) : { closed: false, reason: "not_found" }),
      ...(closing.result?.outcome === "closed" ?
        { engineering: await engineeringItems(session, request, parsed.taskId) } : {}) });
  } catch (error) {
    return failure(error);
  }
}
