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
import { isAmuxV20TaskRegistrationRefusal } from
  "@/lib/amux/ideaUnitRegistrationCore";
import { amuxDatabaseDiagnosticCode } from "@/lib/amux/readFailureCore";
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
  expectedUnitIds: z.array(unitId).min(1).max(36),
}).strict();

/**
 * One structured line for every answer that is not a 201, so a refusal that
 * reaches a browser which already gave up on the request is still visible in
 * the production logs. Codes and class names only: never a body, an id or a
 * message.
 */
const refuse = (status: number, error: string, extra: Record<string, unknown> = {}) => {
  console.warn(JSON.stringify({ subsystem: "amux", event: "idea_plan_approval_refused", code: error, status }));
  return NextResponse.json({ error, ...extra, retryWrite: false }, { status, headers: noStore });
};

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) return refuse(404, "not_found");
    if (getAdminRole(session) !== "owner" || !hasValidMutationOrigin(request)) return refuse(403, "forbidden");
    await assertRecentAdminAuthentication(session);
    if (!amuxV4UnitWriteEnabled(process.env[AMUX_V4_UNIT_WRITE_ENV])) return refuse(503, "unit_write_disabled");
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") return refuse(415, "content_type_refused");
    await consumeApiRateLimit(request, session.user.id, "admin-amux-v4-plan",
      { minute: 3, day: 30 });
    let raw: unknown;
    try { raw = JSON.parse(await readLimitedText(request, 96_000)); }
    catch { return refuse(400, "schema_rejected"); }
    const parsed = body.safeParse(raw);
    if (!parsed.success) return refuse(400, "schema_rejected");
    const result = await approveAmuxV4Plan(session, request, parsed.data);
    return NextResponse.json({ state: "approved", ...result, retryWrite: false },
      { status: 201, headers: noStore });
  } catch (error) {
    if (error instanceof AmuxV4PlanError || error instanceof AmuxV4NodePlanError ||
        error instanceof AmuxV4CardPlanError) {
      return refuse(409, error.code, { draftUnitIds: error.draftUnitIds });
    }
    if (error instanceof AmuxV4DuplicateReasonRequired) {
      return refuse(409, error.code, { candidateIds: error.candidateIds });
    }
    if (isAdminReauthenticationError(error)) {
      // Spelled out (not through refuse()) so the admin write-route guard sees the step-up refusal mapped to 428.
      console.warn(JSON.stringify({ subsystem: "amux", event: "idea_plan_approval_refused",
        code: "ADMIN_REAUTHENTICATION_REQUIRED", status: 428 }));
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED", retryWrite: false },
        { status: 428, headers: noStore });
    }
    if (error instanceof AmuxV4UnitDecisionError) {
      return refuse(error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 :
        error.code === "not_ready" || error.code === "reconfirm" ||
        isAmuxV20TaskRegistrationRefusal(error.code) ? 409 : 503, error.code);
    }
    if (error instanceof AmuxPortfolioError) {
      return refuse(error.code === "forbidden" ? 403 : error.code === "invalid_input" ? 400 :
        error.code === "write_disabled" || error.code === "integrity_unavailable" ? 503 : 409, error.code);
    }
    const security = apiSecurityResponse(error);
    if (security) {
      console.warn(JSON.stringify({ subsystem: "amux", event: "idea_plan_approval_refused",
        code: "api_security", status: security.status }));
      security.headers.set("Cache-Control", noStore["Cache-Control"]);
      return security;
    }
    // The outcome of the write is not known: the browser reads it back and never posts again.
    const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : null;
    console.warn(JSON.stringify({ subsystem: "amux", event: "idea_plan_approval_unknown",
      code: "outcome_unknown", status: 503, name, sqlState: amuxDatabaseDiagnosticCode(error) }));
    return NextResponse.json({ error: "outcome_unknown", retryWrite: false },
      { status: 503, headers: noStore });
  }
}
