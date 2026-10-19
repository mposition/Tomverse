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
  amuxSubscriptionCliCostProfileMatches,
  amuxV4ApprovedCliCostProfileMatches,
  amuxV4ApprovedCliPriceEvidenceDigest } from
  "@/lib/amux/ideaAnalysisApprovedCostProfile";
import { AMUX_IDEA_ANALYSIS_PROVIDERS } from "@/lib/amux/ideaAnalysisChannelCore";
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
const provider = z.enum(AMUX_IDEA_ANALYSIS_PROVIDERS);
const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/);
const bodySchema = z.object({
  id: uuid,
  expectedPreviousVersion: z.number().int().nonnegative().max(2_147_483_646),
  ownerConfirmedWorstTier: z.literal(true),
  // amux-intake v19: the session runner needs the same rates approved as a
  // subscription_cli conversion estimate. Absent keeps the v4 API price.
  mode: z.enum(["api", "subscription_cli"]).optional(),
  // Owner decision 2026-10-20: a subscription_cli price names one approved
  // Frontier model on any of the four CLI channels; the API price stays Opus.
  provider: provider.optional(),
  modelId: modelId.optional(),
}).strict();
const subscriptionModel = z.object({ provider, modelId }).strict();
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
    const subscription = body.mode === "subscription_cli";
    if (subscription !== (body.provider !== undefined) ||
        subscription !== (body.modelId !== undefined)) {
      return NextResponse.json({ error: "Invalid request." },
        { status: 400, headers: noStore });
    }
    // Every subscription price uses the reviewed Opus 5.5 rates, caps and
    // evidence as a conservative estimate (owner decision 2026-10-20).
    const profile = AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE;
    const approval = { id: body.id,
      expectedPreviousVersion: body.expectedPreviousVersion,
      ownerConfirmedWorstTier: body.ownerConfirmedWorstTier,
      provider: subscription ? body.provider! : profile.provider,
      modelId: subscription ? body.modelId! : profile.modelId,
      mode: body.mode ?? profile.mode,
      inputTokensCap: profile.inputTokensCap,
      outputTokensCap: profile.outputTokensCap,
      inputMicroUsdPerMillion: profile.inputMicroUsdPerMillion,
      outputMicroUsdPerMillion: profile.outputMicroUsdPerMillion,
      evidenceDigest: amuxV4ApprovedCliPriceEvidenceDigest(),
      verifiedAt: new Date(AMUX_V4_CLAUDE_OPUS_55_PRICE_EVIDENCE.verifiedAt),
      expiresAt: new Date(AMUX_V4_CLAUDE_OPUS_55_PRICE_EVIDENCE.expiresAt) };
    const result = await prisma.$transaction((tx) =>
      commitAmuxIdeaAnalysisPriceApproval(tx, { session, request, approval,
        ...(subscription ? { requireCurrentFrontierModel: true as const } : {}) }),
    { maxWait: 5_000, timeout: 15_000 });
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

/** The reviewed Opus 5.5 numbers under the requested model and mode. */
function profileReply(model: { provider: string; modelId: string;
  mode: "api" | "subscription_cli" },
latest: { id: string; version: number; status: string; expiresAt: Date } | null,
profileMatches: boolean): Response {
  return NextResponse.json({ state: "profile", profile: {
    ...AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE, ...model,
    maxReservationMicroUsd:
      AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE.maxReservationMicroUsd.toString(),
    ...AMUX_V4_CLAUDE_OPUS_55_PRICE_EVIDENCE,
    evidenceDigest: amuxV4ApprovedCliPriceEvidenceDigest(),
  }, latest: latest ? { id: latest.id, version: latest.version,
    status: latest.status, expiresAt: latest.expiresAt.toISOString(),
    admissible: profileMatches && latest.expiresAt.getTime() > Date.now() } : null },
  { headers: noStore });
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
      // One read per approved Frontier model row of the subscription panel.
      "admin-amux-v4-analysis-price-read", { minute: 30, day: 300 });
    const params = new URL(request.url).searchParams;
    const profileName = params.get("profile");
    const keyCount = [...params.keys()].length;
    if (keyCount === 1 && params.getAll("profile").length === 1 &&
        profileName === "first-live") {
      const profile = AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE;
      const latest = await prisma.amuxIdeaAnalysisPriceVersion.findFirst({
        where: { provider: profile.provider, modelId: profile.modelId, mode: profile.mode },
        orderBy: { version: "desc" },
      });
      return profileReply({ provider: profile.provider, modelId: profile.modelId,
        mode: profile.mode }, latest,
      latest !== null && amuxV4ApprovedCliCostProfileMatches(latest));
    }
    if (keyCount === 3 && profileName === "max-subscription" &&
        ["profile", "provider", "modelId"].every((key) => params.getAll(key).length === 1)) {
      const selected = subscriptionModel.safeParse({ provider: params.get("provider"),
        modelId: params.get("modelId") });
      if (!selected.success) return NextResponse.json({ error: "Invalid request." },
        { status: 400, headers: noStore });
      const latest = await prisma.amuxIdeaAnalysisPriceVersion.findFirst({
        where: { ...selected.data, mode: "subscription_cli" },
        orderBy: { version: "desc" },
      });
      return profileReply({ ...selected.data, mode: "subscription_cli" }, latest,
        latest !== null && amuxSubscriptionCliCostProfileMatches(latest, selected.data));
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
