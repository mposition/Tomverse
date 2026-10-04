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
import { AmuxIdeaAnalysisUnknownResolutionError,
  commitAmuxIdeaAnalysisUnknownResolution } from
  "@/lib/amux/ideaAnalysisUnknownResolutionService";
import { prisma } from "@/lib/prisma";

const WRITE_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_UNKNOWN_RESOLUTION";
const READ_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_READ";
const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const bodySchema = z.object({
  holdId: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/),
  previewId: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/),
  runnerStopped: z.literal(true),
  readBackChecked: z.literal(true),
}).strict();

/** One owner decision closes a fenced unknown attempt at the full Agent-only
 * reserved ceiling. A lost reply is checked through analysis-reservations GET. */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." },
        { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner") {
      return NextResponse.json({ error: "Forbidden." },
        { status: 403, headers: noStore });
    }
    await assertRecentAdminAuthentication(session);
    if (process.env[WRITE_ENV] !== "enabled" || process.env[READ_ENV] !== "enabled") {
      return NextResponse.json({ error: "analysis_unknown_resolution_disabled" },
        { status: 409, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") {
      return NextResponse.json({ error: "Invalid content type." },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-v4-analysis-unknown-resolution", { minute: 2, day: 10 });
    const body = await readLimitedJson(request, 1_024, bodySchema);
    const result = await prisma.$transaction((tx) =>
      commitAmuxIdeaAnalysisUnknownResolution(tx, { ...body,
        session, request }), { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json({ ...result, retryAutomatically: false },
      { headers: noStore });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    if (error instanceof AmuxIdeaAnalysisUnknownResolutionError) {
      return NextResponse.json({ error: error.code, retryAutomatically: false },
        { status: error.code === "forbidden" ? 403 :
          error.code === "not_resolvable" ? 409 : 503, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", noStore["Cache-Control"]);
      return security;
    }
    console.error("AMUX v4 unknown analysis resolution unavailable");
    return NextResponse.json({ error: "outcome_unknown", retryAutomatically: false },
      { status: 503, headers: noStore });
  }
}
