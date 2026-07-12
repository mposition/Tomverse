export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-users-search", {
      minute: 30,
      day: 500,
    });

    const url = new URL(req.url);
    const query = (url.searchParams.get("q") || "").trim();
    const take = Math.min(
      Math.max(Number(url.searchParams.get("take") || 20), 1),
      50
    );

    const users = await prisma.user.findMany({
      where: query
        ? {
            OR: [
              { id: { contains: query, mode: "insensitive" } },
              { email: { contains: query, mode: "insensitive" } },
              { name: { contains: query, mode: "insensitive" } },
              { stripeCustomerId: { contains: query, mode: "insensitive" } },
            ],
          }
        : undefined,
      orderBy: { id: "desc" },
      take,
      select: {
        id: true,
        email: true,
        name: true,
        plan: true,
        subscriptionStatus: true,
        subscriptionCurrentPeriodEnd: true,
        subscriptionBillingInterval: true,
        subscriptionCancelAtPeriodEnd: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        _count: {
          select: {
            conversations: true,
            accounts: true,
            refundRequests: true,
            promotionRedemptions: true,
          },
        },
      },
    });

    return NextResponse.json({
      users: users.map((user) => ({
        ...user,
        subscriptionCurrentPeriodEnd:
          user.subscriptionCurrentPeriodEnd?.toISOString() || null,
      })),
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin user search failed:", error);
    return NextResponse.json(
      { error: "Failed to search users." },
      { status: 500 }
    );
  }
}
