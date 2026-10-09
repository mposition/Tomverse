export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AmuxIdeaAnalysisClaimResolutionError,
  commitAmuxIdeaAnalysisClaimResolution,
  readAmuxIdeaAnalysisClaimResolution,
  readAmuxIdeaAnalysisClaimResolutionReceipt } from
  "@/lib/amux/ideaAnalysisClaimResolutionService";
import { prisma } from "@/lib/prisma";

const READ_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_RESOLUTION_READ";
const WRITE_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_RESOLUTION_WRITE";
const READ_CODE_LATCH = true;
const WRITE_CODE_LATCH = true;
const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const id = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bodySchema = z.object({
  resolutionRequestId: id,
  holdId: id,
  readbackDigest: digest,
  evidenceDigest: digest,
  disposition: z.enum(["not_started_proven", "evidence_insufficient"]),
}).strict();

async function owner() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) return null;
  return getAdminRole(session) === "owner" ? session : "forbidden" as const;
}

function failure(error: unknown): Response {
  if (isAdminReauthenticationError(error)) {
    return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
      { status: 428, headers: noStore });
  }
  if (error instanceof AmuxIdeaAnalysisClaimResolutionError) {
    const status = error.code === "forbidden" ? 403 :
      error.code === "integrity_unavailable" ? 503 : 409;
    return NextResponse.json({ error: error.code, retryWrite: false,
      modelCallStarted: false }, { status, headers: noStore });
  }
  const security = apiSecurityResponse(error);
  if (security) {
    security.headers.set("Cache-Control", noStore["Cache-Control"]);
    return security;
  }
  console.error("AMUX v4 analysis claim resolution unavailable");
  return NextResponse.json({ error: "outcome_unknown", retryWrite: false,
    modelCallStarted: false }, { status: 503, headers: noStore });
}

/** Content-free owner read-back. Reading never authorizes a model retry. */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session === null) return NextResponse.json({ error: "Not found." },
      { status: 404, headers: noStore });
    if (session === "forbidden") return NextResponse.json({ error: "Forbidden." },
      { status: 403, headers: noStore });
    if (!READ_CODE_LATCH || process.env[READ_ENV] !== "enabled") {
      return NextResponse.json({ error: "analysis_claim_resolution_read_disabled" },
        { status: 409, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v4-analysis-claim-resolution-read", { minute: 15, day: 100 });
    const params = new URL(request.url).searchParams;
    const keys = [...params.keys()];
    if (keys.length !== 1 || !["holdId", "resolutionRequestId"].includes(keys[0]!) ||
        params.getAll(keys[0]!).length !== 1) {
      return NextResponse.json({ error: "Invalid request." },
        { status: 400, headers: noStore });
    }
    const value = id.safeParse(params.get(keys[0]!));
    if (!value.success) return NextResponse.json({ error: "Invalid request." },
      { status: 400, headers: noStore });
    if (keys[0] === "resolutionRequestId") {
      const receipt = await prisma.$transaction((tx) =>
        readAmuxIdeaAnalysisClaimResolutionReceipt(tx, { session,
          resolutionRequestId: value.data }), { maxWait: 5_000, timeout: 15_000 });
      return NextResponse.json({ state: receipt.status === "committed"
          ? "resolution_found" : "resolution_absent", receipt,
        retryWrite: false, modelCallStarted: false }, { headers: noStore });
    }
    const readback = await prisma.$transaction((tx) =>
      readAmuxIdeaAnalysisClaimResolution(tx, { session, holdId: value.data }),
      { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json({ state: "resolvable", readback,
      retryAutomatically: false, modelCallStarted: false }, { headers: noStore });
  } catch (error) { return failure(error); }
}

/** Terminal owner decision for one exact read-back and local evidence digest. */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session === null) return NextResponse.json({ error: "Not found." },
      { status: 404, headers: noStore });
    if (session === "forbidden") return NextResponse.json({ error: "Forbidden." },
      { status: 403, headers: noStore });
    if (!READ_CODE_LATCH || process.env[READ_ENV] !== "enabled" ||
        !WRITE_CODE_LATCH || process.env[WRITE_ENV] !== "enabled") {
      return NextResponse.json({ error: "analysis_claim_resolution_disabled" },
        { status: 409, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") return NextResponse.json({ error: "Invalid content type." },
      { status: 415, headers: noStore });
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v4-analysis-claim-resolution-write", { minute: 3, day: 20 });
    const body = await readLimitedJson(request, 2_048, bodySchema);
    const receipt = await prisma.$transaction((tx) =>
      commitAmuxIdeaAnalysisClaimResolution(tx, { ...body, session, request }),
    { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json({ ...receipt, retryAutomatically: false,
      modelCallStarted: false }, { status: receipt.duplicate ? 200 : 201,
      headers: noStore });
  } catch (error) { return failure(error); }
}
