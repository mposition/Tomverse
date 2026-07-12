export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { deleteTomverseAccount } from "@/lib/accountDeletion";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { isAdminSession } from "@/lib/adminAuth";
import { getUserChatUsageKey } from "@/lib/chatSecurity";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";

const deleteUserSchema = z
  .object({
    confirm: z.literal(true),
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
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const usageKey = getUserChatUsageKey(userId);

    const [user, usageRows, recentConversations] = await Promise.all([
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
          settings: {
            select: {
              language: true,
              theme: true,
              defaultModel: true,
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
          _count: {
            select: {
              conversations: true,
              accounts: true,
              refundRequests: true,
              promotionRedemptions: true,
              sessions: true,
            },
          },
        },
      }),
      prisma.chatUsageBucket.findMany({
        where: {
          key: usageKey,
          OR: [
            { period: "day", periodStart: dayStart },
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
    ]);

    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    return NextResponse.json({
      user: {
        ...user,
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
        recentConversations: recentConversations.map((conversation) => ({
          ...conversation,
          createdAt: conversation.createdAt.toISOString(),
          updatedAt: conversation.updatedAt.toISOString(),
        })),
        usage: {
          today:
            usageRows.find((row) => row.period === "day")?.count || 0,
          month:
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

    await readLimitedJson(req, 1024, deleteUserSchema);
    const result = await deleteTomverseAccount(userId);
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
      metadata: {
        email: result.email || null,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
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
