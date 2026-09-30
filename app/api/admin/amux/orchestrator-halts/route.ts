export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { isAmuxOrchestratorUuid } from "@/lib/amux/orchestratorHaltCore";
import {
  AmuxOrchestratorHaltClearError,
  clearAmuxOrchestratorHalt,
} from "@/lib/amux/orchestratorHaltStore";

/**
 * A person clears one AMUX orchestrator halt
 * (docs/policy/development-agent-orchestration.md, version 20, section 7).
 *
 * The owner role and a recent step-up, checked here before anything is read;
 * a stale step-up answers 428 through `adminApprovalErrorResponse`, which the
 * Halts panel renders with the way back. The body is the halt id and the
 * first eight characters of its halt key as the person typed them. The clear
 * writes the human audit `amux.orchestrator.halt_cleared`, the three clear
 * columns and, when the halt names an unresolved request, that request's
 * `human_confirmed` resolution, in one transaction. It never claims, recovers
 * or promotes: the original operation is not run again.
 */

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

const withNoStore = (response: Response) => {
  response.headers.set("Cache-Control", noStoreHeaders["Cache-Control"]);
  return response;
};

const bodySchema = z
  .object({
    haltId: z.string().refine(isAmuxOrchestratorUuid),
    haltKeyPrefix: z.string().max(64),
  })
  .strict();

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    if (getAdminRole(session) !== "owner") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
    }
    await assertRecentAdminAuthentication(session);
    await consumeApiRateLimit(request, session.user.id, "admin-amux-orchestrator-halt-clear", {
      minute: 10,
      day: 100,
    });
    const body = await readLimitedJson(request, 1_024, bodySchema);
    const result = await clearAmuxOrchestratorHalt({
      session,
      request,
      haltId: body.haltId,
      haltKeyPrefix: body.haltKeyPrefix,
    });
    return NextResponse.json(
      { cleared: true, haltId: result.haltId, admissionClosed: result.admissionClosed },
      { headers: noStoreHeaders },
    );
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return withNoStore(approvalResponse);
    if (error instanceof AmuxOrchestratorHaltClearError) {
      return NextResponse.json(
        { error: error.code },
        { status: error.httpStatus, headers: noStoreHeaders },
      );
    }
    const security = apiSecurityResponse(error);
    if (security) return withNoStore(security);
    console.error(
      JSON.stringify({ subsystem: "amux", event: "orchestrator_halt_clear_failed" }),
    );
    return NextResponse.json(
      { error: "orchestrator_halt_clear_failed" },
      { status: 500, headers: noStoreHeaders },
    );
  }
}
