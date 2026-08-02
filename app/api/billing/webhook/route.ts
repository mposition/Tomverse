export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { getStripe } from "@/lib/stripe";
import {
  stripeEventMatchesKeyMode,
  stripeKeyLiveMode,
} from "@/lib/stripeMode";
import { processStripeEvent } from "@/lib/stripeWebhookProcessing";
import { apiSecurityResponse, readLimitedText } from "@/lib/apiSecurity";
import { safeErrorMetadata } from "@/lib/providerErrorClassification";

const MAX_STRIPE_WEBHOOK_BYTES = 1024 * 1024;

export async function POST(req: Request) {
  const signature = req.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !webhookSecret) {
    return NextResponse.json(
      { error: "Stripe webhook is not configured." },
      { status: 503 }
    );
  }

  let event: Stripe.Event;
  let logId: string | null = null;
  try {
    const rawBody = await readLimitedText(req, MAX_STRIPE_WEBHOOK_BYTES);
    event = getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret);

    // Reject a signed event from the other Stripe mode before any database
    // write. This is a second line of defence behind production readiness and
    // also protects a directly reached origin while a deployment is unready.
    const configuredLiveMode = stripeKeyLiveMode(
      process.env.STRIPE_SECRET_KEY
    );
    if (
      !stripeEventMatchesKeyMode(
        event.livemode,
        process.env.STRIPE_SECRET_KEY
      )
    ) {
      console.error("Stripe webhook mode mismatch.", {
        configuredMode:
          configuredLiveMode === null
            ? "unknown"
            : configuredLiveMode
              ? "live"
              : "test",
        eventMode: event.livemode ? "live" : "test",
      });
      return NextResponse.json(
        { error: "Stripe webhook mode mismatch." },
        { status: 400 }
      );
    }

    // Stripe delivers events at-least-once. Skip re-running processing for an
    // event we've already fully processed instead of relying solely on each
    // individual handler's own idempotency.
    const existing = await prisma.stripeWebhookEventLog.findUnique({
      where: { stripeEventId: event.id },
      select: { status: true },
    });
    if (existing?.status === "processed") {
      return NextResponse.json({ received: true, duplicate: true });
    }

    const log = await prisma.stripeWebhookEventLog.upsert({
      where: { stripeEventId: event.id },
      create: {
        stripeEventId: event.id,
        eventType: event.type,
        status: "received",
        payloadSummary: {
          object: event.data.object.object,
          livemode: event.livemode,
        },
      },
      update: {
        eventType: event.type,
        status: "received",
        error: null,
        receivedAt: new Date(),
        payloadSummary: {
          object: event.data.object.object,
          livemode: event.livemode,
        },
      },
    });
    logId = log.id;
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Invalid Stripe webhook signature:", safeErrorMetadata(error));
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  try {
    await processStripeEvent(event);
    if (logId) {
      await prisma.stripeWebhookEventLog.update({
        where: { id: logId },
        data: { status: "processed", processedAt: new Date(), error: null },
      });
    }
    return NextResponse.json({ received: true });
  } catch (error) {
    const errorMetadata = safeErrorMetadata(error);
    console.error("Stripe webhook processing failed:", errorMetadata);
    if (logId) {
      await prisma.stripeWebhookEventLog
        .update({
          where: { id: logId },
          data: {
            status: "failed",
            error: `Webhook processing failed (${errorMetadata.name}${
              errorMetadata.code ? `.${errorMetadata.code}` : ""
            }).`,
          },
        })
        .catch((logError) => {
          console.error(
            "Stripe webhook log update failed:",
            safeErrorMetadata(logError)
          );
        });
    }
    return NextResponse.json(
      { error: "Webhook processing failed." },
      { status: 500 }
    );
  }
}
