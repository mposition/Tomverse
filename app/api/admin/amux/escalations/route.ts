export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
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
      outcome: z.enum(["approve", "block", "retry"]),
      resolution: z.string().trim().min(3).max(1_000),
    })
    .strict(),
]);

const sessionFor = async () => {
  const session = await getServerSession(authOptions);
  return session?.user?.id && isAdminSession(session) ? session : null;
};

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
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 200,
      select: {
        id: true,
        specialty: true,
        reason: true,
        status: true,
        openedBy: true,
        acknowledgedAt: true,
        resolvedAt: true,
        resolution: true,
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
      { escalations },
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
    const escalation = await prisma.amuxHumanEscalation.findUnique({
      where: { id: body.escalation_id },
      select: { id: true, taskId: true, status: true },
    });
    if (!escalation)
      return NextResponse.json({ error: "Not found." }, { status: 404 });

    if (body.action === "acknowledge") {
      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.amuxHumanEscalation.updateMany({
          where: { id: escalation.id, status: "open" },
          data: {
            status: "acknowledged",
            acknowledgedById: session.user.id,
            acknowledgedByEmail: session.user.email ?? null,
            acknowledgedAt: new Date(),
          },
        });
        if (result.count !== 1) return false;
        await writeAdminAuditLog({
          session,
          request,
          action: "amux.human_escalation.acknowledged",
          targetType: "AmuxWorkItem",
          targetId: escalation.taskId,
          summary: `Acknowledged AMUX human escalation ${escalation.id}.`,
          metadata: { escalation_id: escalation.id },
          tx,
        });
        return true;
      });
      return NextResponse.json(
        { success: updated },
        { status: updated ? 200 : 409 },
      );
    }

    // The repository's approved orchestration policy explicitly forbids using
    // the two-person AdminActionApproval contract as an AMUX agent approval.
    // Keep the durable escalation and acknowledgement path available, but do
    // not manufacture an approval authority for resolve/retry/block outcomes.
    return NextResponse.json(
      {
        success: false,
        error:
          "AMUX escalation resolution is unavailable until the separate agent-approval contract is approved and implemented.",
        code: "AMUX_AGENT_APPROVAL_UNAVAILABLE",
      },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to update AMUX escalation:", error);
    return NextResponse.json(
      { error: "Failed to update AMUX escalation." },
      { status: 500 },
    );
  }
}
