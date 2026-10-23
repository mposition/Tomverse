export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { CI_ADMISSION_MAX_CAPACITY } from "@/lib/ciAdmissionCore";
import { changeCiAdmission, readCiAdmissionAdminView, runCiAdmissionRound, stopCiAdmissionPull } from "@/lib/ciAdmissionService";

/**
 * Admin › Agent digests: the CI admission line (lib/ciAdmissionCore.ts).
 * Reading is any administrator; every change is ops:write with a recent
 * sign-in, and is audited. After a change a round runs at once, so moving a
 * pull request to the top releases it as soon as a slot is free.
 */

const prNumber = z.number().int().positive().max(9_999_999);
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reorder"), order: z.array(prNumber).max(100) }).strict(),
  z.object({ action: z.literal("move_top"), number: prNumber }).strict(),
  z.object({ action: z.literal("move_bottom"), number: prNumber }).strict(),
  z.object({ action: z.literal("set_capacity"), capacity: z.number().int().min(1).max(CI_ADMISSION_MAX_CAPACITY) }).strict(),
  z.object({ action: z.literal("evaluate") }).strict(),
  // The operator's stop: back to draft and every run force-cancelled.
  z.object({ action: z.literal("stop"), number: prNumber }).strict(),
]);

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-ci-admission-read", { minute: 60, day: 2000 });
    return NextResponse.json(await readCiAdmissionAdminView());
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load CI admission:", error);
    return NextResponse.json({ error: "Failed to load CI admission." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await assertRecentAdminAuthentication(session);
    await consumeApiRateLimit(req, session.user.id, "admin-ci-admission-write", { minute: 30, day: 500 });
    const body = await readLimitedJson(req, 4096, actionSchema);

    let stop: Awaited<ReturnType<typeof stopCiAdmissionPull>> | undefined;
    if (body.action === "stop") {
      stop = await stopCiAdmissionPull({ session, request: req }, body.number);
    } else if (body.action !== "evaluate") {
      const changed = await changeCiAdmission({ session, request: req }, body);
      if (changed === null) {
        return NextResponse.json({ error: "The line changed; reload and try again.", code: "stale" }, { status: 409 });
      }
    }
    // A round after every change: a pull request moved to the top, or a larger
    // budget, may release one now. A round that cannot run is not an error here.
    const round = await runCiAdmissionRound().catch((error: unknown) => ({
      outcome: "read_failed" as const,
      failure: error instanceof Error ? error.message.slice(0, 80) : "unknown",
    }));
    return NextResponse.json({ ...(await readCiAdmissionAdminView()), round, ...(stop ? { stop } : {}) });
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to update CI admission:", error);
    return NextResponse.json({ error: "Failed to update CI admission." }, { status: 500 });
  }
}
