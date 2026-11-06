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
const cancelSchema = z.object({ ideaId: id, confirmedUnused: z.literal(true) }).strict();
/** One idea has one hold per page; this bounds the read and the releases. */
const IDEA_HOLD_LIMIT = 20;
type HoldFacts = { namespace: string; status: string; reservedMicroUsd: bigint;
  dispatchedAt: Date | null; closedAt: Date | null; settledMicroUsd: bigint | null;
  _count: { cliUsageEvents: number } };
type PreviewFacts = { state: string; consumedAt: Date | null; outcomeUnknownAt: Date | null };
type IdeaHold = HoldFacts & { id: string; previewId: string; preview: PreviewFacts };

/** The writer's own preconditions, read without locks to decide what to offer.
 * The writer re-checks every one of them under its locks. */
function cancellable(hold: HoldFacts, preview: PreviewFacts): boolean {
  return hold.namespace === AMUX_V4_ANALYSIS_NAMESPACE &&
    hold.reservedMicroUsd > BigInt(0) && hold.status === "reserved" && hold.dispatchedAt === null &&
    hold.closedAt === null && hold.settledMicroUsd === null &&
    hold._count.cliUsageEvents === 0 && preview.consumedAt === null &&
    preview.outcomeUnknownAt === null &&
    ["confirmed", "expired", "owner_rejected"].includes(preview.state);
}

const PREVIEW_FACTS = { select: { state: true, consumedAt: true, outcomeUnknownAt: true } } as const;

/** One owned idea's releasable holds, oldest first, else why none can be
 * released; null when the idea is not the owner's. Candidates are filtered by
 * the writer's preconditions in the query itself, so closed holds never fill
 * the bound and hide a later unused one. */
async function ideaHoldView(ideaId: string, ownerId: string) {
  const idea = await prisma.amuxIdeaSubmission.findUnique({
    where: { id: ideaId }, select: { actorUserId: true },
  });
  if (!idea || idea.actorUserId !== ownerId) return null;
  const owned = { ideaId, confirmedByUserId: ownerId };
  const candidates: IdeaHold[] = (await prisma.amuxIdeaAnalysisBudgetHold.findMany({
    where: { namespace: AMUX_V4_ANALYSIS_NAMESPACE, status: "reserved", dispatchedAt: null,
      closedAt: null, settledMicroUsd: null, reservedMicroUsd: { gt: BigInt(0) },
      cliUsageEvents: { none: {} },
      preview: { ...owned, consumedAt: null, outcomeUnknownAt: null,
        state: { in: ["confirmed", "expired", "owner_rejected"] } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: IDEA_HOLD_LIMIT,
    select: { id: true, previewId: true, namespace: true, status: true,
      reservedMicroUsd: true, dispatchedAt: true, closedAt: true, settledMicroUsd: true,
      _count: { select: { cliUsageEvents: true } }, preview: PREVIEW_FACTS },
  })).filter((hold) => cancellable(hold, hold.preview));
  let blocked: "none" | "in_use" | "outcome_unknown" | null = null;
  if (candidates.length === 0) {
    // Any open hold left keeps its reservation; only its own resolution settles it.
    const open = await prisma.amuxIdeaAnalysisBudgetHold.findMany({
      where: { closedAt: null, preview: owned }, take: IDEA_HOLD_LIMIT,
      select: { status: true, preview: PREVIEW_FACTS },
    });
    blocked = open.some((hold) => hold.preview.outcomeUnknownAt !== null ||
      hold.preview.consumedAt !== null || hold.status === "outcome_unknown") ? "outcome_unknown"
      : open.length > 0 ? "in_use" : "none";
  }
  const releasedCount = await prisma.amuxIdeaAnalysisBudgetHold.count({
    where: { status: "released", preview: owned },
  });
  return { candidates, view: {
    releasable: candidates.map((hold) => ({ id: hold.id, reservedMicroUsd: hold.reservedMicroUsd.toString() })),
    releasedCount, blocked,
  } };
}

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
    if (key.length !== 1 || !["holdId", "previewId", "ideaId"].includes(key[0]!) ||
        params.getAll(key[0]!).length !== 1) {
      return NextResponse.json({ error: "Invalid request." },
        { status: 400, headers: noStore });
    }
    const parsed = id.safeParse(params.get(key[0]!));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request." },
      { status: 400, headers: noStore });
    if (key[0] === "ideaId") {
      const found = await ideaHoldView(parsed.data, session.user!.id!);
      if (!found) return NextResponse.json({ error: "Not found." },
        { status: 404, headers: noStore });
      return NextResponse.json({ state: "idea", ideaId: parsed.data, ...found.view,
        retryWrite: false }, { headers: noStore });
    }
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
      dispatchedAt: hold.dispatchedAt?.toISOString() ?? null,
      expiresAt: preview.expiresAt.toISOString(),
      canCancel: cancellable(hold, preview),
      cancellationAuditId: cancellation?.id ?? null,
    }, retryWrite: false }, { headers: noStore });
  } catch (error) { return failure(error); }
}

/** Release every unused hold of one idea, one canonical writer transaction
 * each, from one owner click (operator decision 2026-11-06: no exact-ID lookup
 * step). The server picks the holds; the writer re-checks each under its locks,
 * so a hold claimed meanwhile is skipped and none is released twice. Expired
 * previews stay reachable; a claimed or unknown hold is never zero-released.
 * A failure after some releases is an unknown outcome: the idea is read back. */
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
    const found = await ideaHoldView(body.ideaId, session.user!.id!);
    if (!found) throw new AmuxIdeaAnalysisCancellationError("not_found");
    if (found.candidates.length === 0) {
      return NextResponse.json({ error: "not_cancellable", blocked: found.view.blocked,
        retryWrite: false, modelCallStarted: false }, { status: 409, headers: noStore });
    }
    const released: Array<{ holdId: string; releasedMicroUsd: string; auditId: string }> = [];
    let skipped = 0;
    for (const candidate of found.candidates) {
      try {
        released.push(await prisma.$transaction(async (tx) => {
          const preview = await tx.amuxIdeaTransferPreview.findUnique({
            where: { id: candidate.previewId }, select: { ideaId: true, confirmedByUserId: true,
              idea: { select: { actorUserId: true } } },
          });
          if (!preview || preview.ideaId !== body.ideaId ||
              preview.confirmedByUserId !== session.user!.id! ||
              preview.idea.actorUserId !== session.user!.id!) {
            throw new AmuxIdeaAnalysisCancellationError("not_found");
          }
          return commitAmuxIdeaAnalysisUnusedReservationCancellation(tx, {
            session, request, holdId: candidate.id, expectedPreviewId: candidate.previewId,
          });
        }, { maxWait: 5_000, timeout: 15_000 }));
      } catch (error) {
        // Claimed or released since the read: that hold is not this click's to release.
        if (error instanceof AmuxIdeaAnalysisCancellationError && error.code === "not_cancellable") {
          skipped++; continue;
        }
        if (released.length === 0) throw error;
        console.error("AMUX v4 idea reservation release stopped after a partial commit");
        return NextResponse.json({ error: "outcome_unknown", retryWrite: false,
          modelCallStarted: false }, { status: 503, headers: noStore });
      }
    }
    if (released.length === 0) {
      // Every candidate was claimed meanwhile; say why from a fresh read.
      const after = await ideaHoldView(body.ideaId, session.user!.id!);
      return NextResponse.json({ error: "not_cancellable", blocked: after?.view.blocked ?? null,
        retryWrite: false, modelCallStarted: false }, { status: 409, headers: noStore });
    }
    return NextResponse.json({ ideaId: body.ideaId, released, skipped, modelCallStarted: false },
      { headers: noStore });
  } catch (error) { return failure(error); }
}
