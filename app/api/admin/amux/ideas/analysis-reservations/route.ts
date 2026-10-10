export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { amuxV4ApprovedCliCostProfileMatches } from
  "@/lib/amux/ideaAnalysisApprovedCostProfile";
import { AmuxIdeaAnalysisReservationError,
  AMUX_V4_ANALYSIS_BUDGET_RESERVE_CODE_LATCH,
  commitAmuxIdeaAnalysisBudgetReservation } from
  "@/lib/amux/ideaAnalysisBudgetReservationService";
import { loadAmuxContentKeyRing } from "@/lib/amux/ideaKeyStore";
import { prisma } from "@/lib/prisma";
import { AmuxIdeaAnalysisCancellationError,
  commitAmuxIdeaAnalysisUnusedReservationCancellation } from
  "@/lib/amux/ideaAnalysisBudgetCancellationService";
import { AMUX_V4_ANALYSIS_NAMESPACE } from "@/lib/amux/ideaAnalysisBudgetCore";

const WRITE_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_RESERVE";
const READ_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_READ";
const READ_CODE_LATCH = true;
const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const id = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const bodySchema = z.object({ holdId: id, previewId: id,
  priceVersionId: id }).strict();
const cancelSchema = z.object({ holdId: id, previewId: id,
  confirmedUnused: z.literal(true) }).strict();

async function owner() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) return null;
  if (getAdminRole(session) !== "owner") return "forbidden" as const;
  await assertRecentAdminAuthentication(session);
  return session;
}

function failure(error: unknown): Response {
  if (isAdminReauthenticationError(error)) {
    return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
      { status: 428, headers: noStore });
  }
  if (error instanceof AmuxIdeaAnalysisReservationError) {
    return NextResponse.json({ error: error.code, reason: error.reason,
      retryWrite: false, modelCallStarted: false },
    { status: error.code === "integrity_unavailable" ? 503 : 409,
      headers: noStore });
  }
  if (error instanceof AmuxIdeaAnalysisCancellationError) {
    return NextResponse.json({ error: error.code, retryWrite: false,
      modelCallStarted: false }, { status: error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 :
        error.code === "integrity_unavailable" ? 503 : 409, headers: noStore });
  }
  const security = apiSecurityResponse(error);
  if (security) {
    security.headers.set("Cache-Control", noStore["Cache-Control"]);
    return security;
  }
  console.error("AMUX v4 analysis reservation unavailable");
  return NextResponse.json({ error: "outcome_unknown", retryWrite: false,
    modelCallStarted: false }, { status: 503, headers: noStore });
}

/** The owner confirms the exact price version before the local Agent sees a
 * candidate. This writer reserves but cannot claim or dispatch a model. */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session === null) return NextResponse.json({ error: "Not found." },
      { status: 404, headers: noStore });
    if (session === "forbidden") return NextResponse.json({ error: "Forbidden." },
      { status: 403, headers: noStore });
    if (!AMUX_V4_ANALYSIS_BUDGET_RESERVE_CODE_LATCH ||
        process.env[WRITE_ENV] !== "enabled" ||
        !READ_CODE_LATCH || process.env[READ_ENV] !== "enabled") {
      return NextResponse.json({ error: "analysis_reservation_disabled" },
        { status: 409, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") return NextResponse.json({ error: "Invalid content type." },
      { status: 415, headers: noStore });
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v4-analysis-reserve-write", { minute: 3, day: 20 });
    const body = await readLimitedJson(request, 1_024, bodySchema);
    const [preview, price] = await Promise.all([
      prisma.amuxIdeaTransferPreview.findUnique({ where: { id: body.previewId },
        select: { ideaId: true, confirmedByUserId: true } }),
      prisma.amuxIdeaAnalysisPriceVersion.findUnique({
        where: { id: body.priceVersionId } }),
    ]);
    if (!preview || preview.confirmedByUserId !== session.user!.id!) {
      return NextResponse.json({ error: "Not found." },
        { status: 404, headers: noStore });
    }
    const idea = await prisma.amuxIdeaSubmission.findUnique({
      where: { id: preview.ideaId }, select: { actorUserId: true },
    });
    if (!idea || idea.actorUserId !== session.user!.id!) {
      return NextResponse.json({ error: "Not found." },
        { status: 404, headers: noStore });
    }
    if (!price || !amuxV4ApprovedCliCostProfileMatches(price)) {
      return NextResponse.json({ error: "price_profile_unapproved" },
        { status: 409, headers: noStore });
    }
    let keys;
    try {
      keys = await loadAmuxContentKeyRing([{ ideaId: preview.ideaId,
        purpose: "transfer_payload", subjectId: body.previewId }]);
    } catch {
      throw new AmuxIdeaAnalysisReservationError("integrity_unavailable",
        "transfer_payload_key_unavailable");
    }
    const receipt = await prisma.$transaction((tx) =>
      commitAmuxIdeaAnalysisBudgetReservation(tx, {
        ...body, keys, session, request,
        // The exact, S0-reviewed one-turn Claude profile is the only admitted
        // profile. A new model or changed limits must not inherit these facts.
        runner: { tokenCapsEnforceable: true, billableToolsDisabled: true },
      }), { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json({ ...receipt, modelCallStarted: false },
      { status: 201, headers: noStore });
  } catch (error) { return failure(error); }
}

/** Absence after an unknown POST never authorizes a blind retry. */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session === null) return NextResponse.json({ error: "Not found." },
      { status: 404, headers: noStore });
    if (session === "forbidden") return NextResponse.json({ error: "Forbidden." },
      { status: 403, headers: noStore });
    if (!READ_CODE_LATCH || process.env[READ_ENV] !== "enabled") {
      return NextResponse.json({ error: "analysis_reservation_read_disabled" },
        { status: 409, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v4-analysis-reserve-read", { minute: 15, day: 100 });
    const params = new URL(request.url).searchParams;
    const key = [...params.keys()];
    if (key.length !== 1 || !["holdId", "previewId"].includes(key[0]!) ||
        params.getAll(key[0]!).length !== 1) {
      return NextResponse.json({ error: "Invalid request." },
        { status: 400, headers: noStore });
    }
    const parsed = id.safeParse(params.get(key[0]!));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request." },
      { status: 400, headers: noStore });
    const hold = await prisma.amuxIdeaAnalysisBudgetHold.findUnique({
      where: key[0] === "holdId" ? { id: parsed.data } :
        { previewId: parsed.data }, select: { id: true, previewId: true,
        namespace: true, status: true, reservedMicroUsd: true, dispatchedAt: true,
        closedAt: true, settledMicroUsd: true,
        _count: { select: { cliUsageEvents: true } } },
    });
    if (!hold) return NextResponse.json({ state: "not_visible", retryWrite: false },
      { headers: noStore });
    const preview = await prisma.amuxIdeaTransferPreview.findUnique({
      where: { id: hold.previewId }, select: { confirmedByUserId: true, ideaId: true,
        state: true, consumedAt: true, outcomeUnknownAt: true, expiresAt: true },
    });
    const idea = preview && await prisma.amuxIdeaSubmission.findUnique({
      where: { id: preview.ideaId }, select: { actorUserId: true },
    });
    if (!preview || !idea || preview.confirmedByUserId !== session.user!.id! ||
        idea.actorUserId !== session.user!.id!) {
      return NextResponse.json({ error: "Not found." },
        { status: 404, headers: noStore });
    }
    const cancellation = hold.status === "released" ? await prisma.adminAuditLog.findFirst({
      where: { action: "amux.v4.analysis_budget.unused_reservation_cancelled",
        targetType: "AmuxIdeaAnalysisBudgetHold", targetId: hold.id,
        actorUserId: session.user!.id! }, select: { id: true },
      orderBy: { createdAt: "desc" },
    }) : null;
    return NextResponse.json({ state: "found", hold: {
      id: hold.id, previewId: hold.previewId, status: hold.status,
      reservedMicroUsd: hold.reservedMicroUsd.toString(),
      expiresAt: preview.expiresAt.toISOString(),
      canCancel: hold.namespace === AMUX_V4_ANALYSIS_NAMESPACE &&
        hold.reservedMicroUsd > BigInt(0) && hold.status === "reserved" && hold.dispatchedAt === null &&
        hold.closedAt === null && hold.settledMicroUsd === null &&
        hold._count.cliUsageEvents === 0 && preview.consumedAt === null &&
        preview.outcomeUnknownAt === null &&
        ["confirmed", "expired", "owner_rejected"].includes(preview.state),
      cancellationAuditId: cancellation?.id ?? null,
    }, retryWrite: false }, { headers: noStore });
  } catch (error) { return failure(error); }
}

/** Cancel one unused hold through its canonical writer. Expired previews are
 * deliberately reachable; a claimed or unknown hold is never zero-released. */
export async function DELETE(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session === null) return NextResponse.json({ error: "Not found." },
      { status: 404, headers: noStore });
    if (session === "forbidden") return NextResponse.json({ error: "Forbidden." },
      { status: 403, headers: noStore });
    if (!AMUX_V4_ANALYSIS_BUDGET_RESERVE_CODE_LATCH ||
        process.env[WRITE_ENV] !== "enabled" || !READ_CODE_LATCH ||
        process.env[READ_ENV] !== "enabled") {
      return NextResponse.json({ error: "analysis_reservation_disabled" },
        { status: 409, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") return NextResponse.json({ error: "Invalid content type." },
      { status: 415, headers: noStore });
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v4-analysis-cancel-write", { minute: 3, day: 20 });
    const body = await readLimitedJson(request, 1_024, cancelSchema);
    const receipt = await prisma.$transaction(async (tx) => {
      const preview = await tx.amuxIdeaTransferPreview.findUnique({
        where: { id: body.previewId }, select: { confirmedByUserId: true,
          idea: { select: { actorUserId: true } } },
      });
      if (!preview || preview.confirmedByUserId !== session.user!.id! ||
          preview.idea.actorUserId !== session.user!.id!) {
        throw new AmuxIdeaAnalysisCancellationError("not_found");
      }
      return commitAmuxIdeaAnalysisUnusedReservationCancellation(tx, {
        session, request, holdId: body.holdId, expectedPreviewId: body.previewId,
      });
    }, { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json({ ...receipt, modelCallStarted: false }, { headers: noStore });
  } catch (error) { return failure(error); }
}
