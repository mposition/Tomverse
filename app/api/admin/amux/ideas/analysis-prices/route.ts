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
import { AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE,
  AMUX_V4_CLAUDE_OPUS_55_PRICE_EVIDENCE,
  amuxV4ApprovedCliCostProfileMatches,
  amuxV4ApprovedCliPriceEvidenceDigest } from
  "@/lib/amux/ideaAnalysisApprovedCostProfile";
import { AmuxIdeaAnalysisPriceApprovalError,
  commitAmuxIdeaAnalysisPriceApproval,
  commitAmuxIdeaAnalysisPriceRevocation } from
  "@/lib/amux/ideaAnalysisPriceVersionWrite";
import { prisma } from "@/lib/prisma";

const WRITE_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_PRICE_WRITE";
const READ_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_PRICE_READ";
const WRITE_CODE_LATCH = true;
const READ_CODE_LATCH = true;
const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const uuid = z.string().uuid();
const bodySchema = z.object({
  id: uuid,
  expectedPreviousVersion: z.number().int().nonnegative().max(2_147_483_646),
  ownerConfirmedWorstTier: z.literal(true),
}).strict();
const revokeSchema = z.object({
  priceVersionId: uuid,
  expectedVersion: z.number().int().positive().max(2_147_483_647),
}).strict();

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
  if (error instanceof AmuxIdeaAnalysisPriceApprovalError) {
    return NextResponse.json({ error: error.code, retryWrite: false },
      { status: error.code === "forbidden" ? 403 :
        error.code === "price_unavailable" ? 503 : 409, headers: noStore });
  }
  const security = apiSecurityResponse(error);
  if (security) {
    security.headers.set("Cache-Control", noStore["Cache-Control"]);
    return security;
  }
  console.error("AMUX v4 analysis price approval unavailable");
  return NextResponse.json({ error: "outcome_unknown", retryWrite: false },
    { status: 503, headers: noStore });
}

/** A price version is a human approval, not model dispatch. A lost response is
 * reconciled by exact ID and never retried automatically. */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session === null) return NextResponse.json({ error: "Not found." },
      { status: 404, headers: noStore });
    if (session === "forbidden") return NextResponse.json({ error: "Forbidden." },
      { status: 403, headers: noStore });
    if (!WRITE_CODE_LATCH || process.env[WRITE_ENV] !== "enabled" ||
        !READ_CODE_LATCH || process.env[READ_ENV] !== "enabled") {
      return NextResponse.json({ error: "price_approval_disabled" },
        { status: 409, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") return NextResponse.json({ error: "Invalid content type." },
      { status: 415, headers: noStore });
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v4-analysis-price-write", { minute: 3, day: 20 });
    const body = await readLimitedJson(request, 2_048, bodySchema);
    const profile = AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE;
    const approval = { ...body, provider: profile.provider,
      modelId: profile.modelId, mode: profile.mode,
      inputTokensCap: profile.inputTokensCap,
      outputTokensCap: profile.outputTokensCap,
      inputMicroUsdPerMillion: profile.inputMicroUsdPerMillion,
      outputMicroUsdPerMillion: profile.outputMicroUsdPerMillion,
      evidenceDigest: amuxV4ApprovedCliPriceEvidenceDigest(),
      verifiedAt: new Date(AMUX_V4_CLAUDE_OPUS_55_PRICE_EVIDENCE.verifiedAt),
      expiresAt: new Date(AMUX_V4_CLAUDE_OPUS_55_PRICE_EVIDENCE.expiresAt) };
    const result = await prisma.$transaction((tx) =>
      commitAmuxIdeaAnalysisPriceApproval(tx,
        { session, request, approval }), { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json(result, { status: 201, headers: noStore });
  } catch (error) { return failure(error); }
}

/** An unusable approval must be explicitly revoked before replacement.
 * A lost response is reconciled by exact ID and never retried automatically. */
export async function DELETE(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session === null) return NextResponse.json({ error: "Not found." },
      { status: 404, headers: noStore });
    if (session === "forbidden") return NextResponse.json({ error: "Forbidden." },
      { status: 403, headers: noStore });
    if (!WRITE_CODE_LATCH || process.env[WRITE_ENV] !== "enabled" ||
        !READ_CODE_LATCH || process.env[READ_ENV] !== "enabled") {
      return NextResponse.json({ error: "price_approval_disabled" },
        { status: 409, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") return NextResponse.json({ error: "Invalid content type." },
      { status: 415, headers: noStore });
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v4-analysis-price-revoke", { minute: 2, day: 10 });
    const body = await readLimitedJson(request, 1_024, revokeSchema);
    const result = await prisma.$transaction((tx) =>
      commitAmuxIdeaAnalysisPriceRevocation(tx, { session, request,
        priceVersionId: body.priceVersionId,
        expectedVersion: body.expectedVersion }),
    { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json(result, { headers: noStore });
  } catch (error) { return failure(error); }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session === null) return NextResponse.json({ error: "Not found." },
      { status: 404, headers: noStore });
    if (session === "forbidden") return NextResponse.json({ error: "Forbidden." },
      { status: 403, headers: noStore });
    if (!READ_CODE_LATCH || process.env[READ_ENV] !== "enabled") {
      return NextResponse.json({ error: "price_read_disabled" },
        { status: 409, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v4-analysis-price-read", { minute: 15, day: 100 });
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].length === 1 && params.get("profile") === "first-live" &&
        params.getAll("profile").length === 1) {
      const latest = await prisma.amuxIdeaAnalysisPriceVersion.findFirst({
        where: { provider: AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE.provider,
          modelId: AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE.modelId,
          mode: AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE.mode },
        orderBy: { version: "desc" },
      });
      return NextResponse.json({ state: "profile", profile: {
        ...AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE,
        maxReservationMicroUsd:
          AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE.maxReservationMicroUsd.toString(),
        ...AMUX_V4_CLAUDE_OPUS_55_PRICE_EVIDENCE,
        evidenceDigest: amuxV4ApprovedCliPriceEvidenceDigest(),
      }, latest: latest ? { id: latest.id, version: latest.version,
        status: latest.status, expiresAt: latest.expiresAt.toISOString(),
        admissible: amuxV4ApprovedCliCostProfileMatches(latest) &&
          latest.expiresAt.getTime() > Date.now() } : null },
      { headers: noStore });
    }
    if ([...params.keys()].length !== 1 || params.getAll("id").length !== 1) {
      return NextResponse.json({ error: "Invalid request." },
        { status: 400, headers: noStore });
    }
    const parsed = uuid.safeParse(params.get("id"));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request." },
      { status: 400, headers: noStore });
    const row = await prisma.amuxIdeaAnalysisPriceVersion.findUnique({
      where: { id: parsed.data }, select: {
        id: true, provider: true, modelId: true, mode: true,
        version: true, status: true, inputTokensCap: true,
        outputTokensCap: true, inputMicroUsdPerMillion: true,
        outputMicroUsdPerMillion: true, evidenceDigest: true,
        verifiedAt: true, expiresAt: true, approvedAt: true,
        approvedByUserId: true, approvalAuditLogId: true,
      },
    });
    return NextResponse.json(row ? { state: "found", price: row,
      retryWrite: false } : { state: "not_visible", retryWrite: false },
    { headers: noStore });
  } catch (error) { return failure(error); }
}
