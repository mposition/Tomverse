export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedText } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AMUX_V4_PORTFOLIO_WRITE_ENV, AmuxPortfolioError,
  amuxV4PortfolioWriteEnabled } from "@/lib/amux/portfolioAssessmentService";
import { AMUX_V4_SCORE_PLAN_MAX_ASSESSMENTS, AMUX_V4_SCORE_PLAN_MAX_TASKS,
  AmuxV4ScorePlanError, approveAmuxV4ScorePlan,
  readAmuxV4ScorePlan } from "@/lib/amux/portfolioPlanApprovalService";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

// amux-intake.md v18 item 3 (score part): the assessments the owner confirmed
// on the plan screen, each subject once, then the score of every listed Task,
// in one transaction. Each row keeps its own owner audit entry; a refusal of
// any one rolls the whole plan back. The client chooses planRequestId before
// it sends: the same plan sent twice is refused at its first row, and after
// an unknown outcome GET reads the plan back by that id.

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const opaqueId = z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/);
const body = z.object({
  planRequestId: z.uuid(),
  assessments: z.array(z.object({
    subject: z.object({ kind: z.enum(["initiative", "epic", "feature", "story", "task"]),
      id: opaqueId }).strict(),
    metrics: z.record(z.string(), z.number().int().min(0).max(5)),
    uncertainty: z.enum(["low", "medium", "high"]),
    evidenceRefs: z.array(opaqueId).min(1).max(16),
    modelProposalDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  }).strict()).max(AMUX_V4_SCORE_PLAN_MAX_ASSESSMENTS),
  taskIds: z.array(opaqueId).max(AMUX_V4_SCORE_PLAN_MAX_TASKS),
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
    if (!amuxV4PortfolioWriteEnabled(process.env[AMUX_V4_PORTFOLIO_WRITE_ENV])) {
      return NextResponse.json({ error: "portfolio_write_disabled", retryWrite: false },
        { status: 503, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") {
      return NextResponse.json({ error: "content_type_refused", retryWrite: false },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id, "admin-amux-v4-score-plan",
      { minute: 3, day: 30 });
    let raw: unknown;
    try { raw = JSON.parse(await readLimitedText(request, 64_000)); }
    catch { return NextResponse.json({ error: "schema_rejected", retryWrite: false },
      { status: 400, headers: noStore }); }
    const parsed = body.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: "schema_rejected",
      retryWrite: false }, { status: 400, headers: noStore });
    const result = await approveAmuxV4ScorePlan(session, request, parsed.data);
    return NextResponse.json({ state: "approved", ...result, retryWrite: false },
      { status: 201, headers: noStore });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED",
        retryWrite: false }, { status: 428, headers: noStore });
    }
    if (error instanceof AmuxPortfolioError) {
      return NextResponse.json({ error: error.code, retryWrite: false },
        { status: error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 :
          error.code === "invalid_input" ? 400 :
          error.code === "write_disabled" || error.code === "integrity_unavailable" ? 503 : 409,
          headers: noStore });
    }
    if (error instanceof AmuxV4ScorePlanError) {
      return NextResponse.json({ error: error.code, retryWrite: false },
        { status: 503, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    return NextResponse.json({ error: "outcome_unknown", retryWrite: false },
      { status: 503, headers: noStore });
  }
}

/** Exact read-back by plan request id; absence never invites a retry. */
export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "not_found", retryWrite: false },
        { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner") {
      return NextResponse.json({ error: "forbidden", retryWrite: false },
        { status: 403, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id, "admin-amux-v4-score-plan-read",
      { minute: 15, day: 200 });
    const params = new URL(request.url).searchParams;
    const list = (name: string) => (params.get(name) ?? "").split(",").filter(Boolean);
    const query = z.object({ planRequestId: z.uuid(),
      subjectIds: z.array(opaqueId).max(AMUX_V4_SCORE_PLAN_MAX_ASSESSMENTS),
      taskIds: z.array(opaqueId).max(AMUX_V4_SCORE_PLAN_MAX_TASKS) }).safeParse({
      planRequestId: params.get("planRequestId"), subjectIds: list("subjectIds"), taskIds: list("taskIds") });
    if (!query.success) return NextResponse.json({ error: "schema_rejected", retryWrite: false },
      { status: 400, headers: noStore });
    return NextResponse.json(await readAmuxV4ScorePlan(session, query.data), { headers: noStore });
  } catch (error) {
    if (error instanceof AmuxPortfolioError) {
      return NextResponse.json({ error: error.code, retryWrite: false },
        { status: error.code === "forbidden" ? 403 : 400, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    return NextResponse.json({ error: "read_unavailable", retryWrite: false },
      { status: 503, headers: noStore });
  }
}
