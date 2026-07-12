export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { sendAdminPlanChangedEmail } from "@/lib/billingEmails";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";

type RouteContext = {
  params: Promise<{ userId: string }>;
};

const planAdjustSchema = z
  .object({
    plan: z.enum(["Free", "Pro", "Max"]),
    subscriptionStatus: z.string().trim().max(80).optional(),
    billingInterval: z.enum(["monthly", "annual"]).nullable().optional(),
    periodEnd: z.string().datetime().nullable().optional(),
    cancelAtPeriodEnd: z.boolean().optional(),
    reason: z.string().trim().min(5).max(500),
    confirmText: z.literal("ADJUST PLAN"),
  })
  .strict();

export async function PATCH(req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "billing:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-user-plan-adjust", {
      minute: 6,
      day: 40,
    });

    const { userId } = await context.params;
    const body = await readLimitedJson(req, 4 * 1024, planAdjustSchema);
    const before = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        plan: true,
        subscriptionStatus: true,
        subscriptionCurrentPeriodEnd: true,
        subscriptionBillingInterval: true,
        subscriptionCancelAtPeriodEnd: true,
        settings: {
          select: { language: true },
        },
      },
    });
    if (!before) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        plan: body.plan,
        subscriptionStatus: body.subscriptionStatus || "manually_adjusted",
        subscriptionCurrentPeriodEnd: body.periodEnd ? new Date(body.periodEnd) : null,
        subscriptionBillingInterval: body.billingInterval || null,
        subscriptionCancelAtPeriodEnd: body.cancelAtPeriodEnd || false,
        ...(body.plan === "Free"
          ? {
              stripePriceId: null,
              subscriptionBillingInterval: null,
              subscriptionCurrentPeriodEnd: null,
              subscriptionCancelAtPeriodEnd: false,
            }
          : {}),
      },
      select: {
        id: true,
        email: true,
        plan: true,
        subscriptionStatus: true,
        subscriptionCurrentPeriodEnd: true,
        subscriptionBillingInterval: true,
        subscriptionCancelAtPeriodEnd: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        stripePriceId: true,
      },
    });

    await sendAdminPlanChangedEmail({
      to: user.email,
      plan: user.plan,
      billingInterval: user.subscriptionBillingInterval,
      periodEnd: user.subscriptionCurrentPeriodEnd,
      reason: body.reason,
    }).catch((emailError) => {
      console.error("Admin plan changed email failed:", emailError);
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "user.plan_adjusted",
      targetType: "User",
      targetId: user.id,
      summary: `Adjusted plan for ${user.email || user.id} to ${body.plan}.`,
      metadata: {
        reason: body.reason,
        before: {
          plan: before.plan,
          subscriptionStatus: before.subscriptionStatus,
          subscriptionCurrentPeriodEnd:
            before.subscriptionCurrentPeriodEnd?.toISOString() || null,
          subscriptionBillingInterval: before.subscriptionBillingInterval,
          subscriptionCancelAtPeriodEnd: before.subscriptionCancelAtPeriodEnd,
        },
        after: {
          plan: user.plan,
          subscriptionStatus: user.subscriptionStatus,
          subscriptionCurrentPeriodEnd:
            user.subscriptionCurrentPeriodEnd?.toISOString() || null,
          subscriptionBillingInterval: user.subscriptionBillingInterval,
          subscriptionCancelAtPeriodEnd: user.subscriptionCancelAtPeriodEnd,
        },
      },
    });

    return NextResponse.json({ success: true, user });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin plan adjustment failed:", error);
    return NextResponse.json(
      { error: "Failed to adjust user plan." },
      { status: 500 }
    );
  }
}
