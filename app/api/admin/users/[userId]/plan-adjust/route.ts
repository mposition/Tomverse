export const dynamic = "force-dynamic";
import { effectivePlanForAccess, STORE_ENTITLEMENT_SELECT } from "@/lib/foundingTesterPassCore";
import { lockSubscriptionAccount } from "@/lib/subscriptionEntitlements";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import {
  adminApprovalErrorResponse,
  runWithAdminApproval,
} from "@/lib/adminApproval";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { resolveManualPlanPeriodEnd } from "@/lib/adminPlanAdjustCore";
import { ADMIN_PLAN_CHANGED_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import { isMobileStoreReviewAddress, MOBILE_STORE_REVIEW_STATUS } from "@/lib/mobileAuthKeyring";
import { enqueueStandardEmail } from "@/lib/standardEmailLane";
import {
  apiSecurityResponse,
  ApiSecurityError,
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
        ...STORE_ENTITLEMENT_SELECT,
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
    const subscriptionStatus = body.plan === "Max" && isMobileStoreReviewAddress(before.email)
      ? MOBILE_STORE_REVIEW_STATUS : body.subscriptionStatus || "manually_adjusted";
    const paidStorePlan = effectivePlanForAccess({ plan: "Free", webSubscriptionPlan: "Free",
      storeSubscriptionPlan: before.storeSubscriptionPlan, storeSubscriptionExpiresAt: before.storeSubscriptionExpiresAt,
      storeSubscriptionSnapshot: before.storeSubscriptionSnapshot });
    if (["Free", "Pro", "Max"].indexOf(body.plan) < ["Free", "Pro", "Max"].indexOf(paidStorePlan)) {
      return NextResponse.json({ code: "STORE_SUBSCRIPTION_MANAGED_EXTERNALLY",
        error: "Cancel or refund the store subscription with its original provider before reducing this paid entitlement." }, { status: 409 });
    }

    const user = await runWithAdminApproval(
      {
        session,
        request: req,
        action: "user.plan_adjust",
        targetType: "User",
        targetId: userId,
        payload: body,
        reason: body.reason,
      },
      () => prisma.$transaction(async (tx) => {
        await lockSubscriptionAccount(tx, userId);
        const entitlement = await tx.user.findUniqueOrThrow({ where: { id: userId } });
        const currentStorePlan = effectivePlanForAccess({ ...entitlement, plan: "Free", webSubscriptionPlan: "Free" });
        if (["Free", "Pro", "Max"].indexOf(body.plan) < ["Free", "Pro", "Max"].indexOf(currentStorePlan)) {
          throw new ApiSecurityError(409, "STORE_SUBSCRIPTION_MANAGED_EXTERNALLY", "The paid store entitlement must be cancelled or refunded by its provider first.");
        }
        const periodEnd = resolveManualPlanPeriodEnd(body.plan, body.periodEnd);
        if (subscriptionStatus === MOBILE_STORE_REVIEW_STATUS && (!periodEnd || periodEnd.getTime() <= Date.now() ||
            periodEnd.getTime() > Date.now() + 31 * 86400000)) {
          throw new ApiSecurityError(400, "INVALID_REVIEW_PERIOD", "Store review access requires a future expiry within 31 days.");
        }
        return tx.user.update({
          where: { id: userId },
          data: {
            plan: effectivePlanForAccess({ ...entitlement, plan: body.plan, webSubscriptionPlan: body.plan,
              subscriptionStatus, subscriptionCurrentPeriodEnd: periodEnd }),
            webSubscriptionPlan: body.plan,
            subscriptionStatus,
            // Settled here, not in the browser: a clock-derived value in the
            // request body would differ between the first attempt and the
            // post-approval retry, and the approval is bound to the payload
            // hash. Measured from when the change actually takes effect.
            subscriptionCurrentPeriodEnd: periodEnd,
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
      })
    );

    // Queued: the plan moved whether or not the notice reaches anybody, and
    // somebody whose plan changed under them without a message has no way to
    // tell it from a fault (docs/policy/email-notifications.md §2.4).
    await enqueueStandardEmail({
      templateKey: ADMIN_PLAN_CHANGED_TEMPLATE,
      emailAddress: user.email,
      userId: user.id,
      payload: {
        plan: user.plan,
        billingInterval: user.subscriptionBillingInterval,
        periodEnd: user.subscriptionCurrentPeriodEnd
          ? user.subscriptionCurrentPeriodEnd.toISOString()
          : null,
        reason: body.reason ?? null,
      },
      referenceType: "User",
      referenceId: user.id,
    }).catch((emailError) => {
      console.error("Admin plan changed email enqueue failed:", emailError);
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
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin plan adjustment failed:", error);
    return NextResponse.json(
      { error: "Failed to adjust user plan." },
      { status: 500 }
    );
  }
}
