export const dynamic = "force-dynamic";

import { timingSafeEqual } from "node:crypto";
import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { mobileBillingEnabled, mobileBillingEnvironment, revenueCatWebhookSchema, revenueCatWebhookEnvelopeSchema } from "@/lib/mobileBillingCore";
import { processMobileStoreWebhook } from "@/lib/mobileBillingService";

export async function POST(request: Request) {
  if (!mobileBillingEnabled()) return Response.json({ code: "MOBILE_BILLING_DISABLED" }, { status: 503 });
  const secret = process.env.REVENUECAT_WEBHOOK_AUTHORIZATION;
  const supplied = request.headers.get("authorization") || "";
  if (!secret || secret.length < 32 || Buffer.byteLength(secret) !== Buffer.byteLength(supplied) || !timingSafeEqual(Buffer.from(secret), Buffer.from(supplied))) {
    return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  }
  try {
    const envelope = await readLimitedJson(request, 64 * 1024, revenueCatWebhookEnvelopeSchema);
    if (envelope.event.type === "TRANSFER" || !["APP_STORE", "PLAY_STORE"].includes(envelope.event.store || "")) {
      console.warn("Store notification needs configuration review; no ownership was changed.", { eventType: envelope.event.type, store: envelope.event.store });
      return Response.json({ received: true, ignored: "UNSUPPORTED_STORE_EVENT" });
    }
    const expectedApp = envelope.event.store === "APP_STORE" ? process.env.REVENUECAT_APPLE_APP_ID : process.env.REVENUECAT_GOOGLE_APP_ID;
    if (!expectedApp || envelope.event.app_id !== expectedApp || envelope.event.environment !== mobileBillingEnvironment()) {
      console.warn("Store notification ignored for a different app or environment.");
      return Response.json({ received: true, ignored: "STORE_ENVIRONMENT_MISMATCH" });
    }
    if (envelope.event.type !== "TEST") await processMobileStoreWebhook(revenueCatWebhookSchema.parse(envelope).event);
    return Response.json({ received: true });
  } catch (error) {
    console.warn("Store webhook rejected or deferred.", { errorName: error instanceof Error ? error.name : "UnknownError" });
    if (error instanceof Error && error.name === "StorePurchaseOwnershipError") {
      return Response.json({ received: true, ignored: "STORE_OWNERSHIP_CONFLICT" });
    }
    const response = apiSecurityResponse(error);
    if (response) return response;
    console.warn("Store webhook processing failed.", { errorName: error instanceof Error ? error.name : "UnknownError" });
    return Response.json({ code: "STORE_WEBHOOK_RETRY" }, { status: 503 });
  }
}
