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

    await consumeApiRateLimit(req, session.user.id, "admin-webhook-read", {
      minute: 40,
      day: 800,
    });

    const webhooks = await prisma.stripeWebhookEventLog.findMany({
      orderBy: { receivedAt: "desc" },
      take: 50,
    });

    return NextResponse.json({ webhooks });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load Stripe webhook logs:", error);
    return NextResponse.json(
      { error: "Failed to load webhook logs." },
      { status: 500 }
    );
  }
}
