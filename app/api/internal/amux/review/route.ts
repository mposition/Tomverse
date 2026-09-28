export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import type { Session } from "next-auth";
import { NextResponse } from "next/server";
import { z } from "zod";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import {
  AmuxReviewRefusal,
  acknowledgeAmuxReview,
  createAmuxReviewProposal,
  getAmuxReviewDetail,
  getAmuxReviewDecisionStatus,
  resolveAmuxReview,
} from "@/lib/amux/reviewApproval";
import { isAmuxAgentApprovalEnabled } from "@/lib/amux/reviewApprovalCore";

const cuid = z.string().cuid();
const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("detail"), escalation_id: cuid }).strict(),
  z.object({
    action: z.literal("decision_status"),
    decision_id: z.string().uuid(),
    subject_digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({
    action: z.literal("proposal"),
    escalation_id: cuid,
    outcome: z.enum(["approve", "retry", "block"]),
    expected_subject_digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({
    action: z.literal("resolve"),
    escalation_id: cuid,
    proposal_id: cuid,
    idempotency_key: z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    resolution: z.string().trim().min(3).max(1_000),
  }).strict(),
  z.object({ action: z.literal("acknowledge"), escalation_id: cuid }).strict(),
]);

const noStore = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
  }
  let session: Session | null = null;
  let action: z.infer<typeof commandSchema> | null = null;
  try {
    session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id, "internal-amux-review", {
      minute: 30,
      day: 300,
    });
    action = await readLimitedJson(request, 8 * 1_024, commandSchema);
    if (action.action !== "acknowledge") {
      if (action.action !== "decision_status" &&
          !isAmuxAgentApprovalEnabled(process.env.TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED)) {
        return NextResponse.json(
          { success: false, code: "AMUX_AGENT_APPROVAL_UNAVAILABLE" },
          { status: 409, headers: noStore },
        );
      }
      await assertRecentAdminAuthentication(session);
    }
    if (action.action === "detail") {
      const detail = await getAmuxReviewDetail(action.escalation_id);
      await writeAdminAuditLog({
        session,
        request,
        action: "amux.human_escalation.review_opened",
        targetType: "AmuxWorkItem",
        targetId: detail.task.id,
        summary: "Opened a protected AMUX task review.",
        metadata: {
          escalation_id: detail.escalation.id,
          task_revision: detail.task.revision,
          subject_digest: detail.review_content.digest,
          review_pr_number: detail.review_artifact?.pr_number ?? null,
          review_base_sha: detail.review_artifact?.base_sha ?? null,
          review_head_sha: detail.review_artifact?.head_sha ?? null,
          review_diff_digest: detail.review_artifact?.diff_digest ?? null,
        },
      });
      return NextResponse.json(detail, { headers: noStore });
    }
    const result = action.action === "decision_status"
        ? await getAmuxReviewDecisionStatus(action.decision_id, action.subject_digest)
      : action.action === "proposal"
        ? await createAmuxReviewProposal({
            escalationId: action.escalation_id,
            outcome: action.outcome,
            expectedSubjectDigest: action.expected_subject_digest,
            session,
            request,
          })
        : action.action === "resolve"
          ? await resolveAmuxReview({
              escalationId: action.escalation_id,
              proposalId: action.proposal_id,
              idempotencyKey: action.idempotency_key,
              resolution: action.resolution,
              session,
              request,
            })
          : await acknowledgeAmuxReview({
              escalationId: action.escalation_id,
              session,
              request,
            });
    return NextResponse.json(result, { headers: noStore });
  } catch (error) {
    if (error instanceof AmuxReviewRefusal) {
      if (session?.user?.id && action?.action !== "detail" && action?.action !== "decision_status") {
        try {
          await writeAdminAuditLog({
            session,
            request,
            action: "amux.human_escalation.review_refused",
            targetType: "AmuxWorkItem",
            targetId: null,
            summary: "Refused an AMUX human review command.",
            metadata: {
              code: error.code,
              measured: {
                escalation_id: action?.escalation_id ?? null,
                proposal_id: action?.action === "resolve" ? action.proposal_id : null,
                outcome: action?.action === "proposal" ? action.outcome : null,
              },
              verdict: "refused",
            },
          });
        } catch {
          return NextResponse.json(
            { success: false, code: "AMUX_REVIEW_AUDIT_UNAVAILABLE" },
            { status: 503, headers: noStore },
          );
        }
      }
      return NextResponse.json(
        { success: false, code: error.code },
        { status: error.status, headers: noStore },
      );
    }
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json(
        { code: "ADMIN_REAUTHENTICATION_REQUIRED", error: "Sign in again." },
        { status: 428, headers: noStore },
      );
    }
    const security = apiSecurityResponse(error);
    if (security) return security;
    console.error("AMUX human review command failed", error instanceof Error ? error.name : "unknown");
    return NextResponse.json(
      { success: false, code: "AMUX_REVIEW_INTERNAL_ERROR" },
      { status: 500, headers: noStore },
    );
  }
}
