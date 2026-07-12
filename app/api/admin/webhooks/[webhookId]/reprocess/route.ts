export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";
import { getStripe } from "@/lib/stripe";
import { processStripeEvent } from "@/lib/stripeWebhookProcessing";

type RouteContext = {
  params: Promise<{ webhookId: string }>;
};

export async function POST(req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "billing:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-webhook-reprocess", {
      minute: 6,
      day: 40,
    });

    const { webhookId } = await context.params;
    const log = await prisma.stripeWebhookEventLog.findUnique({
      where: { id: webhookId },
    });
    if (!log?.stripeEventId) {
      return NextResponse.json(
        { error: "Webhook event is not replayable." },
        { status: 400 }
      );
    }

    const event = await getStripe().events.retrieve(log.stripeEventId);
    await processStripeEvent(event);

    const updated = await prisma.stripeWebhookEventLog.update({
      where: { id: log.id },
      data: {
        eventType: event.type,
        status: "processed",
        error: null,
        processedAt: new Date(),
        replayedAt: new Date(),
        replayedById: session.user.id,
        replayedByEmail: session.user.email || null,
        payloadSummary: {
          object: event.data.object.object,
          livemode: event.livemode,
          replayed: true,
        },
      },
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "stripe_webhook.reprocessed",
      targetType: "StripeWebhookEventLog",
      targetId: log.id,
      summary: `Reprocessed Stripe webhook ${log.stripeEventId}.`,
      metadata: {
        stripeEventId: log.stripeEventId,
        eventType: event.type,
        previousStatus: log.status,
      },
    });

    return NextResponse.json({ webhook: updated });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Stripe webhook reprocess failed:", error);
    return NextResponse.json(
      { error: "Failed to reprocess webhook event." },
      { status: 500 }
    );
  }
}
