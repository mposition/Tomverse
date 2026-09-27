export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  runWithAdminApproval,
  adminApprovalErrorResponse,
} from "@/lib/adminApproval";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  AmuxIncidentChangedError,
  clearAmuxIncident,
  declareAmuxIncident,
  getAmuxIncidentSnapshot,
} from "@/lib/amux/incident";

const reason = z.string().trim().min(3).max(500);
const ticket = z.string().trim().min(1).max(120);
const declareSchema = z.object({ reason, ticket }).strict();
const clearSchema = z
  .object({
    action: z.literal("clear"),
    reason,
    ticket,
    expected_transition_id: z.string().trim().min(1).max(120).nullable(),
  })
  .strict();

const adminSession = async () => {
  const session = await getServerSession(authOptions);
  return session?.user?.id && isAdminSession(session) ? session : null;
};

export async function GET(request: Request) {
  try {
    const session = await adminSession();
    if (!session)
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    await consumeApiRateLimit(
      request,
      session.user.id,
      "admin-amux-incident-read",
      {
        minute: 40,
        day: 800,
      },
    );
    return NextResponse.json(await getAmuxIncidentSnapshot(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load AMUX incident mode:", error);
    return NextResponse.json(
      { error: "Failed to load AMUX incident mode." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await adminSession();
    if (!session)
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await consumeApiRateLimit(
      request,
      session.user.id,
      "admin-amux-incident-write",
      {
        minute: 12,
        day: 100,
      },
    );
    const body = await readLimitedJson(request, 4 * 1_024, declareSchema);
    const result = await declareAmuxIncident({ session, request, ...body });
    return NextResponse.json(
      { success: true, ...result },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to declare AMUX incident mode:", error);
    return NextResponse.json(
      { error: "Failed to declare AMUX incident mode." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await adminSession();
    if (!session)
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await consumeApiRateLimit(
      request,
      session.user.id,
      "admin-amux-incident-write",
      {
        minute: 12,
        day: 100,
      },
    );
    const body = await readLimitedJson(request, 4 * 1_024, clearSchema);
    const result = await runWithAdminApproval(
      {
        session,
        request,
        action: "amux.incident.clear",
        targetType: "AppSetting",
        targetId: "amux.incidentMode",
        payload: {
          expected_transition_id: body.expected_transition_id,
          reason: body.reason,
          ticket: body.ticket,
        },
        reason: body.reason,
      },
      (approval) =>
        clearAmuxIncident({
          session,
          request,
          reason: body.reason,
          ticket: body.ticket,
          expectedTransitionId: body.expected_transition_id,
          approval,
        }),
    );
    return NextResponse.json(
      { success: true, ...result },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    if (error instanceof AmuxIncidentChangedError) {
      return NextResponse.json(
        { error: error.message, code: "AMUX_INCIDENT_STATE_CHANGED" },
        { status: 409 },
      );
    }
    console.error("Failed to clear AMUX incident mode:", error);
    return NextResponse.json(
      { error: "Failed to clear AMUX incident mode." },
      { status: 500 },
    );
  }
}
