export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { getInfrastructureDashboard } from "@/lib/infrastructureMonitoring";
import { prisma } from "@/lib/prisma";

const creditSchema = z
  .object({
    service: z.literal("railway"),
    creditUsd: z.number().finite().min(0).max(1_000_000),
    note: z.string().trim().max(300).optional(),
  })
  .strict();

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-infrastructure-read", {
      minute: 12,
      day: 500,
    });
    const dashboard = await getInfrastructureDashboard();
    return NextResponse.json(dashboard, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load infrastructure dashboard:", error);
    return NextResponse.json(
      { error: "Failed to load infrastructure dashboard." },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "billing:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-infrastructure-credit", {
      minute: 8,
      day: 100,
    });
    const body = await readLimitedJson(req, 4 * 1024, creditSchema);
    const creditMicroUsd = BigInt(Math.round(body.creditUsd * 1_000_000));
    const config = await prisma.infrastructureCreditConfig.upsert({
      where: { service: body.service },
      update: {
        creditMicroUsd,
        note: body.note || null,
        updatedById: session.user.id,
        updatedByEmail: session.user.email || null,
      },
      create: {
        service: body.service,
        creditMicroUsd,
        note: body.note || null,
        updatedById: session.user.id,
        updatedByEmail: session.user.email || null,
      },
    });
    await writeAdminAuditLog({
      session,
      request: req,
      action: "infrastructure.credit.updated",
      targetType: "Infrastructure",
      targetId: body.service,
      summary: `Updated ${body.service} monthly credit to $${body.creditUsd.toFixed(2)}.`,
      metadata: {
        service: body.service,
        creditMicroUsd: creditMicroUsd.toString(),
        note: body.note || null,
      },
    });
    return NextResponse.json({
      success: true,
      config: {
        service: config.service,
        creditMicroUsd: Number(config.creditMicroUsd),
        note: config.note,
        updatedAt: config.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to update infrastructure credit:", error);
    return NextResponse.json(
      { error: "Failed to update infrastructure credit." },
      { status: 500 }
    );
  }
}
