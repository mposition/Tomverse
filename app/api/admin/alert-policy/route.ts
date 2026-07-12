export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";

const policySchema = z
  .object({
    id: z.string().trim().max(120).optional(),
    name: z.string().trim().min(2).max(120),
    provider: z.string().trim().max(80).nullable().optional(),
    isActive: z.boolean(),
    budgetThresholds: z.array(z.number().int().min(1).max(100)).min(1).max(5),
    providerFailureThreshold: z.number().int().min(1).max(100),
    modelFailureThreshold: z.number().int().min(1).max(100),
    notifyEmail: z.boolean(),
    notifySlack: z.boolean(),
    notifyDiscord: z.boolean(),
  })
  .strict();

const seedDefaultPolicy = async () => {
  const existing = await prisma.adminAlertPolicy.findFirst({
    where: { provider: null },
  });
  if (existing) return existing;
  return prisma.adminAlertPolicy.create({
    data: {
      name: "Default provider policy",
      provider: null,
      isActive: true,
      budgetThresholds: "[50,80,95]",
      providerFailureThreshold: 5,
      modelFailureThreshold: 3,
      notifyEmail: true,
      notifySlack: Boolean(process.env.SLACK_WEBHOOK_URL),
      notifyDiscord: Boolean(process.env.DISCORD_WEBHOOK_URL),
    },
  });
};

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-alert-policy-read", {
      minute: 40,
      day: 800,
    });

    await seedDefaultPolicy();
    const policies = await prisma.adminAlertPolicy.findMany({
      orderBy: [{ provider: "asc" }, { createdAt: "asc" }],
    });
    return NextResponse.json({ policies });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load alert policies:", error);
    return NextResponse.json(
      { error: "Failed to load alert policies." },
      { status: 500 }
    );
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

    await consumeApiRateLimit(req, session.user.id, "admin-alert-policy-write", {
      minute: 12,
      day: 120,
    });

    const body = await readLimitedJson(req, 8 * 1024, policySchema);
    const data = {
      name: body.name,
      provider: body.provider || null,
      isActive: body.isActive,
      budgetThresholds: JSON.stringify(body.budgetThresholds),
      providerFailureThreshold: body.providerFailureThreshold,
      modelFailureThreshold: body.modelFailureThreshold,
      notifyEmail: body.notifyEmail,
      notifySlack: body.notifySlack,
      notifyDiscord: body.notifyDiscord,
      updatedById: session.user.id,
      updatedByEmail: session.user.email || null,
    };

    const policy = body.id
      ? await prisma.adminAlertPolicy.update({
          where: { id: body.id },
          data,
        })
      : await prisma.adminAlertPolicy.create({
          data: {
            ...data,
            createdById: session.user.id,
            createdByEmail: session.user.email || null,
          },
        });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "alert_policy.updated",
      targetType: "AdminAlertPolicy",
      targetId: policy.id,
      summary: `Updated alert policy ${policy.name}.`,
      metadata: {
        provider: policy.provider,
        isActive: policy.isActive,
      },
    });

    return NextResponse.json({ policy });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to update alert policy:", error);
    return NextResponse.json(
      { error: "Failed to update alert policy." },
      { status: 500 }
    );
  }
}
