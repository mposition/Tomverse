export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { deleteTomverseAccount } from "@/lib/accountDeletion";
import {
  adminApprovalErrorResponse,
  runWithAdminApproval,
} from "@/lib/adminApproval";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { getUserChatUsageKey } from "@/lib/chatSecurity";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";
import { getZonedDayWindow } from "@/lib/userTimeZone";

const deleteUserSchema = z
  .object({
    confirm: z.literal(true),
    confirmText: z.literal("DELETE USER"),
  })
  .strict();

type RouteContext = {
  params: Promise<{ userId: string }>;
};

export async function GET(req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-user-detail", {
      minute: 40,
      day: 800,
    });

    const { userId } = await context.params;
    const now = new Date();
    const userTimeZone = await prisma.userSettings.findUnique({
      where: { userId },
      select: { timeZone: true },
    });
    const dayWindow = getZonedDayWindow(userTimeZone?.timeZone, now);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const usageKey = getUserChatUsageKey(userId);

    const [user, usageRows, recentConversations, auditEvents, messagesToday] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          image: true,
          plan: true,
          stripeCustomerId: true,
          stripeSubscriptionId: true,
          stripePriceId: true,
          subscriptionStatus: true,
          subscriptionCurrentPeriodEnd: true,
          subscriptionBillingInterval: true,
          subscriptionCancelAtPeriodEnd: true,
          creditDebtCredits: true,
          creditDebtCostMicroUsd: true,
          billingRiskStatus: true,
          billingRiskReason: true,
          billingRiskAt: true,
          accountStatus: true,
          accountSuspendedAt: true,
          accountSuspendedUntil: true,
          accountSuspensionReason: true,
          aiUsageRestricted: true,
          aiUsageRestrictedAt: true,
          aiUsageRestrictedUntil: true,
          aiUsageRestrictionReason: true,
          securityIncidentNote: true,
          lastLoginAt: true,
          settings: {
            select: {
              language: true,
              theme: true,
              defaultModel: true,
              timeZone: true,
              updatedAt: true,
            },
          },
          accounts: {
            select: {
              provider: true,
              providerAccountId: true,
              type: true,
            },
          },
          refundRequests: {
            orderBy: { requestedAt: "desc" },
            take: 5,
            select: {
              id: true,
              status: true,
              plan: true,
              reason: true,
              requestedAt: true,
              reviewedAt: true,
              stripeRefundStatus: true,
              refundAmountCents: true,
            },
          },
          promotionRedemptions: {
            orderBy: { redeemedAt: "desc" },
            take: 5,
            select: {
              id: true,
              planId: true,
              billingInterval: true,
              redeemedAt: true,
              stripeCheckoutSessionId: true,
              promotion: {
                select: {
                  code: true,
                  discountPercent: true,
                  discountAmountCents: true,
                },
              },
            },
          },
          creditPurchases: {
            orderBy: { purchasedAt: "desc" },
            take: 10,
            select: {
              id: true,
              packId: true,
              creditsPurchased: true,
              fundedCostMicroUsd: true,
              amountPaidCents: true,
              amountPaidUsdMicroUsd: true,
              currency: true,
              refundedAmountCents: true,
              revokedCredits: true,
              revokedCostMicroUsd: true,
              unrecoveredCredits: true,
              unrecoveredCostMicroUsd: true,
              stripeCheckoutSessionId: true,
              stripePaymentIntentId: true,
              stripeChargeId: true,
              stripeDisputeId: true,
              disputeStatus: true,
              status: true,
              purchasedAt: true,
              expiresAt: true,
              lots: {
                select: {
                  remainingCredits: true,
                  remainingFundedCostMicroUsd: true,
                  status: true,
                },
              },
            },
          },
          creditDebtEntries: {
            orderBy: { createdAt: "desc" },
            take: 20,
            select: {
              id: true,
              purchaseId: true,
              type: true,
              creditsDelta: true,
              fundedCostMicroUsdDelta: true,
              balanceAfterCredits: true,
              balanceAfterCostMicroUsd: true,
              createdAt: true,
            },
          },
          chatCreditReservations: {
            orderBy: { createdAt: "desc" },
            take: 10,
            select: {
              id: true,
              traceId: true,
              source: true,
              provider: true,
              modelId: true,
              status: true,
              outcome: true,
              providerRequestId: true,
              providerResponseId: true,
              reservedCredits: true,
              settledCredits: true,
              reservedCostMicroUsd: true,
              settledCostMicroUsd: true,
              expiresAt: true,
              settledAt: true,
              reconciledAt: true,
              lastError: true,
              createdAt: true,
            },
          },
          privacyRequests: {
            orderBy: { createdAt: "desc" },
            take: 10,
            select: {
              id: true,
              requestType: true,
              status: true,
              dueAt: true,
              legalHold: true,
              createdAt: true,
            },
          },
          _count: {
            select: {
              conversations: true,
              accounts: true,
              refundRequests: true,
              promotionRedemptions: true,
              sessions: true,
              creditPurchases: true,
              chatCreditReservations: true,
            },
          },
        },
      }),
      prisma.chatUsageBucket.findMany({
        where: {
          key: usageKey,
          OR: [
            { period: "day", periodStart: dayWindow.start },
            { period: "month", periodStart: monthStart },
          ],
        },
        select: { period: true, count: true, updatedAt: true },
      }),
      prisma.conversation.findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: {
          id: true,
          title: true,
          shareEnabled: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { messages: true } },
        },
      }),
      prisma.adminAuditLog.findMany({
        where: {
          OR: [
            { targetId: userId },
            { metadata: { path: ["userId"], equals: userId } },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          action: true,
          summary: true,
          actorEmail: true,
          createdAt: true,
        },
      }),
      prisma.message.count({
        where: {
          conversation: { userId },
          createdAt: { gte: dayWindow.start, lt: dayWindow.end },
        },
      }),
    ]);

    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    return NextResponse.json({
      user: {
        ...user,
        creditDebtCostMicroUsd: Number(user.creditDebtCostMicroUsd),
        billingRiskAt: user.billingRiskAt?.toISOString() || null,
        accountSuspendedAt: user.accountSuspendedAt?.toISOString() || null,
        accountSuspendedUntil: user.accountSuspendedUntil?.toISOString() || null,
        aiUsageRestrictedAt: user.aiUsageRestrictedAt?.toISOString() || null,
        aiUsageRestrictedUntil: user.aiUsageRestrictedUntil?.toISOString() || null,
        lastLoginAt: user.lastLoginAt?.toISOString() || null,
        subscriptionCurrentPeriodEnd:
          user.subscriptionCurrentPeriodEnd?.toISOString() || null,
        settings: user.settings
          ? {
              ...user.settings,
              updatedAt: user.settings.updatedAt.toISOString(),
            }
          : null,
        refundRequests: user.refundRequests.map((request) => ({
          ...request,
          requestedAt: request.requestedAt.toISOString(),
          reviewedAt: request.reviewedAt?.toISOString() || null,
        })),
        promotionRedemptions: user.promotionRedemptions.map((redemption) => ({
          ...redemption,
          redeemedAt: redemption.redeemedAt.toISOString(),
        })),
        creditPurchases: user.creditPurchases.map((purchase) => ({
          ...purchase,
          fundedCostMicroUsd: Number(purchase.fundedCostMicroUsd),
          amountPaidUsdMicroUsd: Number(purchase.amountPaidUsdMicroUsd),
          revokedCostMicroUsd: Number(purchase.revokedCostMicroUsd),
          unrecoveredCostMicroUsd: Number(purchase.unrecoveredCostMicroUsd),
          purchasedAt: purchase.purchasedAt.toISOString(),
          expiresAt: purchase.expiresAt.toISOString(),
          remainingCredits: purchase.lots.reduce(
            (sum, lot) => sum + lot.remainingCredits,
            0
          ),
          remainingFundedCostMicroUsd: purchase.lots.reduce(
            (sum, lot) => sum + Number(lot.remainingFundedCostMicroUsd),
            0
          ),
          lots: purchase.lots.map((lot) => ({
            ...lot,
            remainingFundedCostMicroUsd: Number(lot.remainingFundedCostMicroUsd),
          })),
        })),
        creditDebtEntries: user.creditDebtEntries.map((entry) => ({
          ...entry,
          fundedCostMicroUsdDelta: Number(entry.fundedCostMicroUsdDelta),
          balanceAfterCostMicroUsd: Number(entry.balanceAfterCostMicroUsd),
          createdAt: entry.createdAt.toISOString(),
        })),
        chatCreditReservations: user.chatCreditReservations.map((reservation) => ({
          ...reservation,
          reservedCostMicroUsd: Number(reservation.reservedCostMicroUsd),
          settledCostMicroUsd: Number(reservation.settledCostMicroUsd),
          expiresAt: reservation.expiresAt.toISOString(),
          settledAt: reservation.settledAt?.toISOString() || null,
          reconciledAt: reservation.reconciledAt?.toISOString() || null,
          createdAt: reservation.createdAt.toISOString(),
        })),
        recentConversations: recentConversations.map((conversation) => ({
          ...conversation,
          createdAt: conversation.createdAt.toISOString(),
          updatedAt: conversation.updatedAt.toISOString(),
        })),
        timeline: [
          ...user.refundRequests.map((request) => ({
            id: request.id,
            type: "refund",
            title: `Refund ${request.status}`,
            detail: request.reason || request.stripeRefundStatus || "",
            at: request.requestedAt.toISOString(),
          })),
          ...user.promotionRedemptions.map((redemption) => ({
            id: redemption.id,
            type: "promotion",
            title: `Promotion ${redemption.promotion.code}`,
            detail: `${redemption.planId} / ${redemption.billingInterval}`,
            at: redemption.redeemedAt.toISOString(),
          })),
          ...recentConversations.map((conversation) => ({
            id: conversation.id,
            type: "conversation",
            title: conversation.title,
            detail: `${conversation._count.messages} messages`,
            at: conversation.updatedAt.toISOString(),
          })),
          ...auditEvents.map((event) => ({
            id: event.id,
            type: "audit",
            title: event.action,
            detail: `${event.summary} / ${event.actorEmail || "admin"}`,
            at: event.createdAt.toISOString(),
          })),
          ...user.privacyRequests.map((request) => ({
            id: request.id,
            type: "privacy",
            title: `Privacy ${request.requestType} / ${request.status}`,
            detail: `Due ${request.dueAt.toISOString()}${request.legalHold ? " / legal hold" : ""}`,
            at: request.createdAt.toISOString(),
          })),
          ...user.creditDebtEntries.slice(0, 10).map((entry) => ({
            id: entry.id,
            type: "credit",
            title: `Credit debt ${entry.type}`,
            detail: `${entry.creditsDelta} credits`,
            at: entry.createdAt.toISOString(),
          })),
          ...(user.lastLoginAt ? [{
            id: `last-login-${user.id}`,
            type: "login",
            title: "Most recent successful login",
            detail: user.accountStatus === "suspended" ? "Account is currently suspended" : "Account active",
            at: user.lastLoginAt.toISOString(),
          }] : []),
        ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 20),
        usage: {
          timeZone: dayWindow.timeZone,
          dayStart: dayWindow.start.toISOString(),
          dayEnd: dayWindow.end.toISOString(),
          messagesToday,
          creditsToday:
            usageRows.find((row) => row.period === "day")?.count || 0,
          creditsMonth:
            usageRows.find((row) => row.period === "month")?.count || 0,
        },
      },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin user detail failed:", error);
    return NextResponse.json(
      { error: "Failed to load user detail." },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "user:delete")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-user-delete", {
      minute: 5,
      day: 50,
    });

    const { userId } = await context.params;
    if (userId === session.user.id) {
      return NextResponse.json(
        { error: "Admins cannot delete their own account from the admin console." },
        { status: 400 }
      );
    }

    const body = await readLimitedJson(req, 1024, deleteUserSchema);
    const result = await runWithAdminApproval(
      {
        session,
        request: req,
        action: "user.delete",
        targetType: "User",
        targetId: userId,
        payload: body,
        reason: `Permanently delete user ${userId}.`,
      },
      async () => {
        const deletion = await deleteTomverseAccount(userId);
        if (!deletion.deleted) throw new Error("User not found.");
        return deletion;
      }
    );
    if (!result.deleted) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    await writeAdminAuditLog({
      session,
      request: req,
      action: "user.deleted",
      targetType: "User",
      targetId: userId,
      summary: `Deleted user account ${result.email || userId}.`,
      metadata: { email: result.email || null },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin user deletion failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to delete user: ${error.message}`
            : "Failed to delete user.",
      },
      { status: 500 }
    );
  }
}
