export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { publicAmuxEscalationReasonCode } from "@/lib/amux/escalation";
import { forwardAmuxAdminReviewCommand } from "@/lib/amux/reviewAdminProxy";
import { isAmuxAgentApprovalEnabled } from "@/lib/amux/reviewApprovalCore";
import { prisma } from "@/lib/prisma";

const mutationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("acknowledge"),
      escalation_id: z.string().cuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("resolve"),
      escalation_id: z.string().cuid(),
      proposal_id: z.string().cuid(),
      idempotency_key: z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/),
      resolution: z.string().trim().min(3).max(1_000),
    })
    .strict(),
]);

const sessionFor = async () => {
  const session = await getServerSession(authOptions);
  return session?.user?.id && isAdminSession(session) ? session : null;
};

const safeTitle = (value: string) =>
  value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 200);

export async function GET(request: Request) {
  try {
    const session = await sessionFor();
    if (!session)
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    await consumeApiRateLimit(
      request,
      session.user.id,
      "admin-amux-escalations-read",
      {
        minute: 30,
        day: 800,
      },
    );
    const escalations = await prisma.amuxHumanEscalation.findMany({
      where: { status: { in: ["open", "acknowledged"] } },
      orderBy: [{ createdAt: "desc" }],
      take: 200,
      select: {
        id: true,
        specialty: true,
        status: true,
        openedBy: true,
        acknowledgedAt: true,
        resolvedAt: true,
        createdAt: true,
        task: {
          select: {
            id: true,
            title: true,
            status: true,
            priority: true,
            revision: true,
          },
        },
      },
    });
    return NextResponse.json(
      {
        escalations: escalations.map((escalation) => ({
          ...escalation,
          task: { ...escalation.task, title: safeTitle(escalation.task.title) },
          reason_code: publicAmuxEscalationReasonCode(escalation.task.status),
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    return NextResponse.json(
      { error: "Failed to load AMUX escalations." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await sessionFor();
    if (!session)
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await consumeApiRateLimit(
      request,
      session.user.id,
      "admin-amux-escalations-write",
      {
        minute: 20,
        day: 200,
      },
    );
    const body = await readLimitedJson(request, 8 * 1_024, mutationSchema);
    if (body.action === "acknowledge" &&
        !isAmuxAgentApprovalEnabled(process.env.TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED)) {
      // Preserve the pre-existing acknowledgement path while the new approval
      // feature is off; rollout must not require a new internal secret merely
      // to acknowledge an escalation. The enabled path uses the canonical
      // internal review boundary instead.
      const updated = await prisma.$transaction(async (tx) => {
        const changed = await tx.amuxHumanEscalation.updateMany({
          where: { id: body.escalation_id, status: "open" },
          data: {
            status: "acknowledged",
            acknowledgedById: session.user.id,
            acknowledgedByEmail: session.user.email ?? null,
            acknowledgedAt: new Date(),
          },
        });
        if (changed.count !== 1) return false;
        const escalation = await tx.amuxHumanEscalation.findUniqueOrThrow({
          where: { id: body.escalation_id }, select: { taskId: true },
        });
        await writeAdminAuditLog({
          session,
          request,
          action: "amux.human_escalation.acknowledged",
          targetType: "AmuxWorkItem",
          targetId: escalation.taskId,
          summary: "Acknowledged an AMUX human escalation.",
          metadata: { escalation_id: body.escalation_id },
          tx,
        });
        return true;
      });
      return NextResponse.json(
        { success: updated },
        { status: updated ? 200 : 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (body.action === "resolve") {
      await assertRecentAdminAuthentication(session);
    }
    return forwardAmuxAdminReviewCommand(request, body);
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json(
        { code: "ADMIN_REAUTHENTICATION_REQUIRED", error: "Sign in again." },
        { status: 428 },
      );
    }
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to update AMUX escalation:", error);
    return NextResponse.json(
      { error: "Failed to update AMUX escalation." },
      { status: 500 },
    );
  }
}
