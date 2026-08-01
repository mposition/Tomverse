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
import { prisma } from "@/lib/prisma";
import { isStripeConfigured } from "@/lib/stripe";
import { resyncAccountBillingFromStripe } from "@/lib/stripeWebhookProcessing";

const inputSchema = z.object({ userId: z.string().min(1).max(64) }).strict();

/**
 * Re-reads one account's subscription from Stripe and stores what it says.
 *
 * The webhook path is self-healing -- every event triggers a fresh read -- but
 * self-healing only helps for events that arrive. A dropped delivery, an
 * endpoint that was misconfigured for a while, or a change made directly in the
 * Stripe dashboard leaves an account stale with nothing to correct it. Before
 * this, the fix was editing the database by hand.
 *
 * The read is stamped with the current time, so it always outranks whatever a
 * late webhook might still deliver. That is the intended behaviour: an operator
 * asking for a resync is asserting that Stripe, right now, is the truth.
 */
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "billing:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    if (!isStripeConfigured()) {
      return NextResponse.json(
        { code: "STRIPE_NOT_CONFIGURED", error: "Stripe is not configured." },
        { status: 503 }
      );
    }

    await consumeApiRateLimit(req, session.user.id, "admin-billing-resync", {
      minute: 10,
      day: 200,
    });

    const { userId } = await readLimitedJson(req, 2 * 1024, inputSchema);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        plan: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        subscriptionStatus: true,
        subscriptionSyncedAt: true,
      },
    });
    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    if (!user.stripeCustomerId) {
      return NextResponse.json(
        {
          code: "NO_STRIPE_CUSTOMER",
          error: "This account has never been linked to a Stripe customer.",
        },
        { status: 409 }
      );
    }

    const outcome = await resyncAccountBillingFromStripe({
      userId: user.id,
      stripeCustomerId: user.stripeCustomerId,
      stripeSubscriptionId: user.stripeSubscriptionId,
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "billing.subscription.resynced",
      targetType: "User",
      targetId: user.id,
      summary: `Resynced billing from Stripe: ${user.plan} -> ${outcome.plan} (${outcome.result}).`,
      metadata: {
        result: outcome.result,
        planBefore: user.plan,
        planAfter: outcome.plan,
        subscriptionStatusBefore: user.subscriptionStatus,
        subscriptionStatusAfter: outcome.subscriptionStatus,
        stripeSubscriptionIdBefore: user.stripeSubscriptionId,
        stripeSubscriptionIdAfter: outcome.stripeSubscriptionId,
        observedAt: outcome.observedAt.toISOString(),
      },
    });

    return NextResponse.json({
      result: outcome.result,
      plan: outcome.plan,
      subscriptionStatus: outcome.subscriptionStatus,
      stripeSubscriptionId: outcome.stripeSubscriptionId,
      observedAt: outcome.observedAt.toISOString(),
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin billing resync failed:", error);
    return NextResponse.json(
      { code: "RESYNC_FAILED", error: "Failed to resync billing from Stripe." },
      { status: 500 }
    );
  }
}
