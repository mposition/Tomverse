export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AMUX_PROCESS_AUDIT_MAX_CADENCE_DAYS, AMUX_PROCESS_AUDIT_MIN_CADENCE_DAYS } from "@/lib/amuxProcessAuditCore";
import { changeProcessAuditSettings } from "@/lib/amuxProcessAuditStore";
import { prisma } from "@/lib/prisma";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

const schema = z.object({
  enabled: z.boolean(),
  cadenceDays: z.number().int().min(AMUX_PROCESS_AUDIT_MIN_CADENCE_DAYS).max(AMUX_PROCESS_AUDIT_MAX_CADENCE_DAYS),
  runNow: z.boolean(),
  ownerConfirmed: z.literal(true),
}).strict();

/**
 * The owner's controls of the AMUX process analysis agent: the schedule
 * switch, its cadence and "run now". The run is the box's flat-rate Codex CLI,
 * so none of these spends money; they are still the owner's, after a recent
 * sign-in, and each change is one audit entry in the transaction that saves it.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
      return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
    }
    await assertRecentAdminAuthentication(session);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return NextResponse.json({ error: "Invalid content type." }, { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id, "admin-amux-process-audit-settings", { minute: 5, day: 40 });
    const change = await readLimitedJson(request, 1_024, schema);
    const saved = await prisma.$transaction(async (tx) => {
      const { before, after } = await changeProcessAuditSettings(tx, change);
      await writeAdminAuditLog({
        session,
        request,
        action: "amux.process_audit.settings_changed",
        targetType: "amux_process_audit",
        targetId: "settings",
        summary: change.runNow ? "Requested an AMUX process analysis run" : "Changed the AMUX process analysis schedule",
        metadata: {
          before: { enabled: before.enabled, cadenceDays: before.cadenceDays },
          after: { enabled: after.enabled, cadenceDays: after.cadenceDays },
          runRequestedAt: after.runRequestedAt,
        },
        tx,
      });
      return after;
    }, { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json({
      state: "saved",
      enabled: saved.enabled,
      cadenceDays: saved.cadenceDays,
      runRequestedAt: saved.runRequestedAt,
    }, { headers: noStore });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" }, { status: 428, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", noStore["Cache-Control"]);
      return security;
    }
    return NextResponse.json({ error: "outcome_unknown" }, { status: 503, headers: noStore });
  }
}
