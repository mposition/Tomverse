export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedText } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AmuxPortfolioError, approveAmuxPortfolioAssessment,
  previewAmuxPortfolioAssessment, readAmuxPortfolioAssessment } from
  "@/lib/amux/portfolioAssessmentService";
import { confirmAmuxPortfolioScore, previewAmuxPortfolioScore,
  readAmuxPortfolioScore, readLatestAmuxPortfolioScore } from
  "@/lib/amux/portfolioScoreService";
import { amuxPortfolioAssessmentApprovalSchema,
  amuxPortfolioAssessmentPayloadSchema,
  amuxPortfolioScoreApprovalSchema,
  amuxPortfolioScorePayloadSchema } from "@/lib/amux/portfolioScoreSchemas";
import { loadCurrentAmuxContentKeys } from "@/lib/amux/ideaKeyConfig";
import { AmuxV4TaskReadyError, readAmuxV4TaskReady } from
  "@/lib/amux/v4TaskReadyService";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview_assessment"),
    payload: amuxPortfolioAssessmentPayloadSchema }).strict(),
  z.object({ action: z.literal("approve_assessment"),
    approval: amuxPortfolioAssessmentApprovalSchema }).strict(),
  z.object({ action: z.literal("preview_score"),
    payload: amuxPortfolioScorePayloadSchema }).strict(),
  z.object({ action: z.literal("confirm_score"),
    approval: amuxPortfolioScoreApprovalSchema }).strict(),
]);

export async function POST(request: Request) {
  let requestId: string | null = null;
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "not_found" },
        { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner" || !hasValidMutationOrigin(request)) {
      return NextResponse.json({ error: "forbidden" },
        { status: 403, headers: noStore });
    }
    await assertRecentAdminAuthentication(session);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") {
      return NextResponse.json({ error: "content_type_refused" },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-v4-portfolio", { minute: 6, day: 80 });
    let raw: unknown;
    try { raw = JSON.parse(await readLimitedText(request, 12_288)); }
    catch { return NextResponse.json({ error: "schema_rejected" },
      { status: 400, headers: noStore }); }
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: "schema_rejected" },
      { status: 400, headers: noStore });
    const keys = loadCurrentAmuxContentKeys(process.env);
    const action = parsed.data;
    if (action.action === "preview_assessment") {
      const plan = await previewAmuxPortfolioAssessment(session,
        action.payload, keys);
      return NextResponse.json({ confirmationDigest: plan.confirmationDigest,
        subjectRevision: plan.subjectRevision,
        assessmentVersion: plan.assessmentVersion,
        priorMetrics: plan.priorMetrics,
        nextMetrics: plan.metrics, evidenceAsOf: plan.evidenceAsOf,
        retryWrite: false }, { headers: noStore });
    }
    if (action.action === "approve_assessment") {
      requestId = action.approval.payload.requestId;
      const result = await approveAmuxPortfolioAssessment({ session, request,
        ...action.approval, digestKey: keys });
      return NextResponse.json({ ...result, retryWrite: false },
        { status: 201, headers: noStore });
    }
    if (action.action === "preview_score") {
      const plan = await previewAmuxPortfolioScore(session, action.payload, keys);
      return NextResponse.json({ confirmationDigest: plan.inputDigest,
        score: plan.score, assessmentIds: {
          initiative: plan.initiativeAssessmentId,
          epic: plan.epicAssessmentId, feature: plan.featureAssessmentId,
          story: plan.storyAssessmentId, task: plan.taskAssessmentId },
        promotionAuthorized: false, retryWrite: false }, { headers: noStore });
    }
    requestId = action.approval.payload.requestId;
    const result = await confirmAmuxPortfolioScore({ session, request,
      ...action.approval, digestKey: keys });
    return NextResponse.json({ ...result, promotionAuthorized: false,
      retryWrite: false }, { status: 201, headers: noStore });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    if (error instanceof AmuxPortfolioError) {
      return NextResponse.json({ error: error.code, retryWrite: false },
        { status: error.code === "invalid_input" ? 400 :
          error.code === "not_found" ? 404 :
          error.code === "forbidden" ? 403 :
          error.code === "write_disabled" ? 503 : 409,
          headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    return NextResponse.json({ error: requestId ? "outcome_unknown" :
      "portfolio_preview_unavailable", requestId,
      retryWrite: false }, { status: 503, headers: noStore });
  }
}

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "not_found" },
        { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner") {
      return NextResponse.json({ error: "forbidden" },
        { status: 403, headers: noStore });
    }
    await assertRecentAdminAuthentication(session);
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-v4-portfolio-readback", { minute: 12, day: 120 });
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind");
    if (kind === "latest_score") {
      const taskId = url.searchParams.get("taskId") ?? "";
      const result = await readLatestAmuxPortfolioScore(session, taskId);
      return NextResponse.json(result, { headers: noStore });
    }
    if (kind === "task_ready") {
      const result = await readAmuxV4TaskReady(session,
        url.searchParams.get("taskId") ?? "");
      return NextResponse.json(result, { headers: noStore });
    }
    const requestId = url.searchParams.get("requestId") ?? "";
    if (!z.uuid().safeParse(requestId).success ||
        (kind !== "assessment" && kind !== "score")) {
      return NextResponse.json({ error: "schema_rejected" },
        { status: 400, headers: noStore });
    }
    const result = kind === "assessment" ?
      await readAmuxPortfolioAssessment(session, requestId) :
      await readAmuxPortfolioScore(session, requestId);
    return NextResponse.json(result, { headers: noStore });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    if (error instanceof AmuxV4TaskReadyError) {
      return NextResponse.json({ error: error.code }, {
        status: error.code === "not_found" ? 404 :
          error.code === "forbidden" ? 403 : 503, headers: noStore });
    }
    if (error instanceof AmuxPortfolioError) {
      return NextResponse.json({ error: error.code }, {
        status: error.code === "not_found" ? 404 :
          error.code === "forbidden" ? 403 :
          error.code === "not_ready" ? 409 : 503, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    return NextResponse.json({ error: "portfolio_readback_unavailable" },
      { status: 503, headers: noStore });
  }
}
