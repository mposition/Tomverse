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

const inputSchema = z
  .object({
    action: z.literal("release_hold"),
    reason: z.string().trim().min(5).max(1_000),
    confirmText: z.literal("RELEASE BILLING HOLD"),
  })
  .strict();

type RouteContext = {
  params: Promise<{ userId: string }>;
};

export async function PATCH(req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "billing:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-billing-risk", {
      minute: 10,
      day: 100,
    });

    const { userId } = await context.params;
    const body = await readLimitedJson(req, 4 * 1024, inputSchema);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        billingRiskStatus: true,
        billingRiskReason: true,
        creditDebtCredits: true,
        creditDebtCostMicroUsd: true,
      },
    });
    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    if (user.billingRiskStatus !== "disputed_hold") {
      return NextResponse.json(
        { error: "This account does not have an active billing hold." },
        { status: 409 }
      );
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        billingRiskStatus: "normal",
        billingRiskReason: null,
        billingRiskAt: null,
      },
      select: {
        billingRiskStatus: true,
        billingRiskReason: true,
        billingRiskAt: true,
        creditDebtCredits: true,
        creditDebtCostMicroUsd: true,
      },
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "billing_risk.hold_released",
      targetType: "User",
      targetId: userId,
      summary: `Released payment-dispute hold for ${user.email || userId}.`,
      metadata: {
        reason: body.reason,
        previousRiskReason: user.billingRiskReason,
        outstandingCreditDebt: user.creditDebtCredits,
        outstandingCostDebtMicroUsd: Number(user.creditDebtCostMicroUsd),
      },
    });

    return NextResponse.json({
      success: true,
      user: {
        ...updated,
        billingRiskAt: updated.billingRiskAt?.toISOString() || null,
        creditDebtCostMicroUsd: Number(updated.creditDebtCostMicroUsd),
      },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin billing-risk update failed:", error);
    return NextResponse.json(
      { error: "Failed to update billing risk." },
      { status: 500 }
    );
  }
}
