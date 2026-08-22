export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";

import { readLimitedText } from "@/lib/apiSecurity";
import { emailProvider } from "@/lib/emailProviderPort";
import { processResendWebhook } from "@/lib/emailWebhookProcessing";

/**
 * Receives Resend's delivery, bounce and complaint events.
 *
 * Contract: docs/policy/email-notifications.md §9.6, §13.5.
 *
 * `runtime = "nodejs"` is load-bearing: the signature covers the raw bytes, and
 * verifying it needs `node:crypto` and a body that has not been through a parse
 * and a re-serialise. `force-dynamic` is belt and braces -- Next 16 does not
 * cache non-GET handlers -- but it is cheap and states the intent.
 *
 * This endpoint is unauthenticated by necessity, so everything downstream of it
 * treats the payload as hostile until the signature says otherwise. Nothing is
 * read out of the body before verification, and a failure never echoes the body
 * back or into a log: it names the recipient.
 */

const MAX_WEBHOOK_BYTES = 512 * 1024;

export async function POST(req: Request) {
  let rawBody: string;
  try {
    rawBody = await readLimitedText(req, MAX_WEBHOOK_BYTES);
  } catch {
    return NextResponse.json(
      { error: "Invalid request." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Verification belongs to the provider port: the signature scheme is the
  // provider's, and a second place that knows it is a second place to get it
  // wrong (docs/policy/email-notifications.md §8.2).
  const verification = emailProvider().verifyWebhook(rawBody, req.headers);
  if (!verification.ok) {
    // The reason is logged, the body is not.
    console.warn(
      JSON.stringify({
        event: "email_webhook_rejected",
        reason: verification.reason,
        at: new Date().toISOString(),
      })
    );
    // A missing secret is not 401 and not 400: nothing was wrong with the
    // request. Answering 503 keeps the provider retrying, so events queue at
    // Resend rather than being dropped while a deployment misses its secret.
    // A body that is signed but not JSON says so, rather than blaming the
    // signature that just verified.
    const [status, error] =
      verification.reason === "secret_missing"
        ? ([503, "Email webhook is not configured."] as const)
        : verification.reason === "payload_not_json"
          ? ([400, "Invalid payload."] as const)
          : ([400, "Invalid signature."] as const);
    return NextResponse.json(
      { error },
      { status, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    await processResendWebhook({
      providerEventId: verification.id,
      payload: verification.payload as Parameters<
        typeof processResendWebhook
      >[0]["payload"],
    });
    // Acknowledgement only. The provider needs to know we accepted it; our
    // delivery ids and effect names are of no use to it and echoing internal
    // identifiers to an external caller is a habit worth not forming.
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    // A 500 asks the provider to redeliver, which is what we want: the event is
    // already recorded with its error, and the replay guard makes the retry
    // safe to accept.
    console.error(
      JSON.stringify({
        event: "email_webhook_processing_failed",
        reason: error instanceof Error ? error.name : "unknown",
        at: new Date().toISOString(),
      })
    );
    return NextResponse.json(
      { error: "Processing failed." },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
