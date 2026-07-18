export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import {
  getOperationalCheckpoints,
  OPERATIONAL_CHECKPOINT_DEFINITIONS,
} from "@/lib/operationalCheckpoints";
import { prisma } from "@/lib/prisma";

const keys = OPERATIONAL_CHECKPOINT_DEFINITIONS.map((item) => item.key) as [
  (typeof OPERATIONAL_CHECKPOINT_DEFINITIONS)[number]["key"],
  ...(typeof OPERATIONAL_CHECKPOINT_DEFINITIONS)[number]["key"][],
];

const updateSchema = z.object({
  key: z.enum(keys),
  status: z.enum(["healthy", "warning", "failed", "not_configured"]),
  observedAt: z.string().datetime(),
  nextDueAt: z.string().datetime(),
  detail: z.string().trim().max(2_000).nullable(),
  evidenceUrl: z.string().url().max(1_000).nullable(),
}).strict();

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-operational-checkpoints-read", {
      minute: 30,
      day: 800,
    });
    return NextResponse.json({ checkpoints: await getOperationalCheckpoints() });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Operational checkpoints load failed:", error);
    return NextResponse.json({ error: "Failed to load operational checkpoints." }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-operational-checkpoints-write", {
      minute: 15,
      day: 200,
    });
    const body = await readLimitedJson(req, 8 * 1024, updateSchema);
    const definition = OPERATIONAL_CHECKPOINT_DEFINITIONS.find((item) => item.key === body.key)!;
    const checkpoint = await prisma.adminOperationalCheckpoint.upsert({
      where: { key: body.key },
      create: {
        key: body.key,
        name: definition.name,
        status: body.status,
        observedAt: new Date(body.observedAt),
        nextDueAt: new Date(body.nextDueAt),
        detail: body.detail,
        evidenceUrl: body.evidenceUrl,
        updatedById: session.user.id,
        updatedByEmail: session.user.email || null,
      },
      update: {
        name: definition.name,
        status: body.status,
        observedAt: new Date(body.observedAt),
        nextDueAt: new Date(body.nextDueAt),
        detail: body.detail,
        evidenceUrl: body.evidenceUrl,
        updatedById: session.user.id,
        updatedByEmail: session.user.email || null,
      },
    });
    await writeAdminAuditLog({
      session,
      request: req,
      action: "operations.checkpoint.updated",
      targetType: "AdminOperationalCheckpoint",
      targetId: checkpoint.key,
      summary: `Updated ${checkpoint.name} checkpoint to ${checkpoint.status}.`,
      metadata: {
        observedAt: checkpoint.observedAt?.toISOString() || null,
        nextDueAt: checkpoint.nextDueAt?.toISOString() || null,
        evidenceUrl: checkpoint.evidenceUrl,
      },
    });
    return NextResponse.json({ checkpoints: await getOperationalCheckpoints() });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Operational checkpoint update failed:", error);
    return NextResponse.json({ error: "Failed to update operational checkpoint." }, { status: 500 });
  }
}
