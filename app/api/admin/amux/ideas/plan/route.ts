export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedText } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AmuxV4CardPlanError } from "@/lib/amux/ideaCardPlanApprovalService";
import { AmuxV4NodePlanError } from "@/lib/amux/ideaNodePlanApprovalService";
import { AmuxV4PlanError, approveAmuxV4Plan } from "@/lib/amux/ideaPlanApprovalService";
import { AMUX_V4_UNIT_WRITE_ENV, AmuxV4DuplicateReasonRequired,
  AmuxV4UnitDecisionError, amuxV4UnitWriteEnabled } from "@/lib/amux/ideaUnitDecisionStore";
import { AmuxPortfolioError } from "@/lib/amux/portfolioAssessmentService";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

// amux-intake.md v18 item 3: the owner's one plan approval. Every proposed
// node, every proposed Story and Task (first round of a large plan) and the
// assessments and Task scores confirmed on the screen are written in one
// transaction; a refusal of anything rolls everything back. Read-back after an
// unknown outcome uses the existing per-unit reads and the score plan GET.

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const unitId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
const opaqueId = z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/);
const assessmentFields = {
  metrics: z.record(z.string(), z.number().int().min(0).max(5)),
  uncertainty: z.enum(["low", "medium", "high"]),
  evidenceRefs: z.array(opaqueId).min(1).max(16),
  modelProposalDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
};
const body = z.object({
  ideaId: unitId,
  planRequestId: z.uuid(),
  reasons: z.record(unitId, z.string().min(3).max(500)).default({}),
  publicPrConsentOff: z.array(unitId).max(24).default([]),
  assessments: z.array(z.union([
    z.object({ unitId, ...assessmentFields }).strict(),
    z.object({ subject: z.object({ kind: z.enum(["initiative", "epic", "feature", "story", "task"]),
      id: opaqueId }).strict(), ...assessmentFields }).strict(),
  ])).max(64).default([]),
  scoreTaskUnitIds: z.array(unitId).max(32).default([]),
}).strict();

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "not_found", retryWrite: false },
        { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner" || !hasValidMutationOrigin(request)) {
      return NextResponse.json({ error: "forbidden", retryWrite: false },
        { status: 403, headers: noStore });
    }
    await assertRecentAdminAuthentication(session);
    if (!amuxV4UnitWriteEnabled(process.env[AMUX_V4_UNIT_WRITE_ENV])) {
      return NextResponse.json({ error: "unit_write_disabled", retryWrite: false },
        { status: 503, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") {
      return NextResponse.json({ error: "content_type_refused", retryWrite: false },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id, "admin-amux-v4-plan",
      { minute: 3, day: 30 });
    let raw: unknown;
    try { raw = JSON.parse(await readLimitedText(request, 96_000)); }
    catch { return NextResponse.json({ error: "schema_rejected", retryWrite: false },
      { status: 400, headers: noStore }); }
    const parsed = body.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: "schema_rejected",
      retryWrite: false }, { status: 400, headers: noStore });
    const result = await approveAmuxV4Plan(session, request, parsed.data);
    return NextResponse.json({ state: "approved", ...result, retryWrite: false },
      { status: 201, headers: noStore });
  } catch (error) {
    if (error instanceof AmuxV4PlanError || error instanceof AmuxV4NodePlanError ||
        error instanceof AmuxV4CardPlanError) {
      return NextResponse.json({ error: error.code, draftUnitIds: error.draftUnitIds,
        retryWrite: false }, { status: 409, headers: noStore });
    }
    if (error instanceof AmuxV4DuplicateReasonRequired) {
      return NextResponse.json({ error: error.code, candidateIds: error.candidateIds,
        retryWrite: false }, { status: 409, headers: noStore });
    }
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED",
        retryWrite: false }, { status: 428, headers: noStore });
    }
    if (error instanceof AmuxV4UnitDecisionError) {
      return NextResponse.json({ error: error.code, retryWrite: false },
        { status: error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 :
          error.code === "not_ready" || error.code === "reconfirm" ? 409 : 503,
          headers: noStore });
    }
    if (error instanceof AmuxPortfolioError) {
      return NextResponse.json({ error: error.code, retryWrite: false },
        { status: error.code === "forbidden" ? 403 : error.code === "invalid_input" ? 400 :
          error.code === "write_disabled" || error.code === "integrity_unavailable" ? 503 : 409,
          headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    return NextResponse.json({ error: "outcome_unknown", retryWrite: false },
      { status: 503, headers: noStore });
  }
}
