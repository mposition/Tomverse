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
import { AmuxIdeaSessionAnalysisStopError,
  commitAmuxIdeaSessionAnalysisStop,
  readAmuxIdeaSessionAnalysisStopState } from
  "@/lib/amux/ideaSessionAnalysisStopService";
import { prisma } from "@/lib/prisma";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const ideaId = z.string().uuid();
const body = z.object({ ideaId, claimId: z.string().uuid(),
  ownerConfirmed: z.literal(true) }).strict();

async function owner() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) return null;
  if (getAdminRole(session) !== "owner") return "forbidden" as const;
  await assertRecentAdminAuthentication(session);
  return session;
}

function failure(error: unknown): Response {
  if (isAdminReauthenticationError(error)) {
    return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED",
      retryWrite: false }, { status: 428, headers: noStore });
  }
  if (error instanceof AmuxIdeaSessionAnalysisStopError) {
    return NextResponse.json({ error: error.code, retryWrite: false },
      { status: error.code === "forbidden" ? 403 :
        error.code === "not_found" ? 404 :
        error.code === "not_stoppable" ? 409 : 503, headers: noStore });
  }
  const security = apiSecurityResponse(error);
  if (security) {
    security.headers.set("Cache-Control", noStore["Cache-Control"]);
    return security;
  }
  return NextResponse.json({ error: "outcome_unknown", retryWrite: false },
    { status: 503, headers: noStore });
}

/** Running state with its start time, or the stop receipt. An uncertain stop
 * is reconciled here by idea ID and never retried blind. */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (!session) return NextResponse.json({ error: "not_found" },
      { status: 404, headers: noStore });
    if (session === "forbidden") return NextResponse.json({ error: "forbidden" },
      { status: 403, headers: noStore });
    await consumeApiRateLimit(request, session.user!.id!,
      // The open control polls every 30 s while visible (2,880 a day per tab).
      "admin-amux-v19-session-analysis-stop-read", { minute: 30, day: 5_000 });
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].length !== 1 || params.getAll("ideaId").length !== 1) {
      return NextResponse.json({ error: "schema_rejected" },
        { status: 400, headers: noStore });
    }
    const parsed = ideaId.safeParse(params.get("ideaId"));
    if (!parsed.success) return NextResponse.json({ error: "schema_rejected" },
      { status: 400, headers: noStore });
    const state = await prisma.$transaction((tx) =>
      readAmuxIdeaSessionAnalysisStopState(tx, session, parsed.data),
    { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json(state, { headers: noStore });
  } catch (error) { return failure(error); }
}

/** Owner-only stop of the exact in-flight claim the control displayed. A stop
 * narrows what runs, so no intake switch has to be on for it to work. */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (!session) return NextResponse.json({ error: "not_found", retryWrite: false },
      { status: 404, headers: noStore });
    if (session === "forbidden" || !hasValidMutationOrigin(request)) {
      return NextResponse.json({ error: "forbidden", retryWrite: false },
        { status: 403, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") {
      return NextResponse.json({ error: "content_type_refused", retryWrite: false },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v19-session-analysis-stop-write", { minute: 3, day: 20 });
    const parsed = await readLimitedJson(request, 512, body);
    const receipt = await prisma.$transaction((tx) =>
      commitAmuxIdeaSessionAnalysisStop(tx, { ...parsed, session, request }),
    { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json({ state: "stopped", ...receipt, retryWrite: false },
      { status: 201, headers: noStore });
  } catch (error) { return failure(error); }
}
