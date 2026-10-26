export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AmuxIdeaAnalysisStopError, commitAmuxIdeaAnalysisStop,
  readAmuxIdeaAnalysisStopReceipt } from
  "@/lib/amux/ideaAnalysisStopService";
import { prisma } from "@/lib/prisma";

const READ_ENV = "TOMVERSE_AMUX_V19_ANALYSIS_STOP_READ";
const WRITE_ENV = "TOMVERSE_AMUX_V19_ANALYSIS_STOP_WRITE";
const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const id = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const bodySchema = z.object({ stopRequestId: id, holdId: id,
  ownerConfirmed: z.literal(true) }).strict();

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
  if (error instanceof AmuxIdeaAnalysisStopError) {
    const status = error.code === "forbidden" ? 403 :
      error.code === "integrity_unavailable" ? 503 : 409;
    return NextResponse.json({ error: error.code, retryWrite: false },
      { status, headers: noStore });
  }
  const security = apiSecurityResponse(error);
  if (security) {
    security.headers.set("Cache-Control", noStore["Cache-Control"]);
    return security;
  }
  return NextResponse.json({ error: "outcome_unknown", retryWrite: false },
    { status: 503, headers: noStore });
}

/** Content-free read-back of an uncertain stop response. An absent receipt
 * never authorizes a second write. */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session === null) return NextResponse.json({ error: "Not found." },
      { status: 404, headers: noStore });
    if (session === "forbidden") return NextResponse.json({ error: "Forbidden." },
      { status: 403, headers: noStore });
    if (process.env[READ_ENV] !== "enabled") {
      return NextResponse.json({ error: "analysis_stop_read_disabled" },
        { status: 409, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v19-analysis-stop-read", { minute: 15, day: 100 });
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].length !== 1 ||
        params.getAll("stopRequestId").length !== 1) {
      return NextResponse.json({ error: "Invalid request." },
        { status: 400, headers: noStore });
    }
    const stopRequestId = id.safeParse(params.get("stopRequestId"));
    if (!stopRequestId.success) return NextResponse.json({ error: "Invalid request." },
      { status: 400, headers: noStore });
    const receipt = await prisma.$transaction((tx) =>
      readAmuxIdeaAnalysisStopReceipt(tx, { session,
        stopRequestId: stopRequestId.data }),
    { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json(receipt, { headers: noStore });
  } catch (error) { return failure(error); }
}

/** Owner-confirmed DB fence. The worker observes it through the stop-poll
 * route; the read and write switches remain independently default-off. */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session === null) return NextResponse.json({ error: "Not found." },
      { status: 404, headers: noStore });
    if (session === "forbidden") return NextResponse.json({ error: "Forbidden." },
      { status: 403, headers: noStore });
    if (process.env[READ_ENV] !== "enabled" ||
        process.env[WRITE_ENV] !== "enabled") {
      return NextResponse.json({ error: "analysis_stop_disabled" },
        { status: 409, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") return NextResponse.json({ error: "Invalid content type." },
      { status: 415, headers: noStore });
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v19-analysis-stop-write", { minute: 3, day: 20 });
    const body = await readLimitedJson(request, 1_024, bodySchema);
    const receipt = await prisma.$transaction((tx) =>
      commitAmuxIdeaAnalysisStop(tx, { ...body, session, request }),
    { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json(receipt, { status: 201, headers: noStore });
  } catch (error) { return failure(error); }
}
