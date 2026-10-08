export const dynamic = "force-dynamic";

import type { Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedText } from "@/lib/apiSecurity";
import {
  AMUX_V4_INITIAL_PLAN_MAX_BYTES,
  AMUX_V4_INITIAL_PLAN_READBACK_ENV,
  AMUX_V4_INITIAL_PLAN_WRITE_ENV,
  initialPlanReadbackPermitted,
  initialPlanWritePermitted,
  inspectInitialPlanRequest,
} from "@/lib/amux/ideaInitialSourcePlanCore";
import {
  InitialPlanAccessError,
  prepareInitialIdeaSourcePlan,
  readInitialIdeaSourcePlan,
} from "@/lib/amux/ideaInitialSourcePlanAccess";
import { InitialSourcePlanError } from "@/lib/amux/ideaInitialSourcePlanService";
import { isAmuxIdeaRequestId } from "@/lib/amux/ideaSubmissionCore";
import { authOptions } from "@/lib/auth";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

async function owner(): Promise<Session | NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
  }
  if (getAdminRole(session) !== "owner") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403, headers: noStore });
  }
  try { await assertRecentAdminAuthentication(session); } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    throw error;
  }
  return session;
}

function failure(error: unknown): Response {
  if (error instanceof InitialPlanAccessError) {
    return NextResponse.json({ error: error.code,
      ...(error.readBack ? { readBack: error.readBack } : {}) },
    { status: error.status, headers: noStore });
  }
  if (error instanceof InitialSourcePlanError) {
    const status = error.code === "not_found" ? 404 :
      error.code === "integrity_unavailable" ? 503 : 409;
    return NextResponse.json({ error: error.code }, { status, headers: noStore });
  }
  const approval = adminApprovalErrorResponse(error);
  if (approval) { approval.headers.set("Cache-Control", noStore["Cache-Control"]); return approval; }
  const security = apiSecurityResponse(error);
  if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
  console.error("AMUX v4 initial source plan failed");
  return NextResponse.json({ error: "plan_unavailable" }, { status: 503, headers: noStore });
}

/** Dark, idea-only source-plan writer. No GitHub read or model call. */
export async function POST(request: Request) {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!initialPlanWritePermitted(process.env[AMUX_V4_INITIAL_PLAN_WRITE_ENV]) ||
        !initialPlanReadbackPermitted(process.env[AMUX_V4_INITIAL_PLAN_READBACK_ENV])) {
      return NextResponse.json({ error: "plan_disabled" }, { status: 503, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return NextResponse.json({ error: "content_type_refused" }, { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-initial-plan-write", {
      minute: 3, day: 20,
    });
    const inspected = inspectInitialPlanRequest(await readLimitedText(request, AMUX_V4_INITIAL_PLAN_MAX_BYTES));
    if (!inspected.ok) {
      return NextResponse.json({ error: inspected.code },
        { status: inspected.code === "too_large" ? 413 : 400, headers: noStore });
    }
    const result = await prepareInitialIdeaSourcePlan(session, request, inspected.ideaId);
    return NextResponse.json({ ideaId: inspected.ideaId, revisionId: result.revisionId,
      status: "committed", transferAuthorized: false }, { status: 201, headers: noStore });
  } catch (error) { return failure(error); }
}

/** Metadata-only recovery; an absent result never means retry the POST. */
export async function GET(request: Request) {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!initialPlanReadbackPermitted(process.env[AMUX_V4_INITIAL_PLAN_READBACK_ENV])) {
      return NextResponse.json({ error: "plan_disabled" }, { status: 503, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-initial-plan-readback", {
      minute: 10, day: 100,
    });
    const ideaId = new URL(request.url).searchParams.get("ideaId");
    if (!ideaId || !isAmuxIdeaRequestId(ideaId)) {
      return NextResponse.json({ error: "schema_rejected" }, { status: 400, headers: noStore });
    }
    return NextResponse.json(await readInitialIdeaSourcePlan(session, ideaId), { headers: noStore });
  } catch (error) { return failure(error); }
}
