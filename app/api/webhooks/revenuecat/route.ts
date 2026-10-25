export const dynamic = "force-dynamic";

import { timingSafeEqual } from "node:crypto";
import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { mobileBillingEnabled, mobileBillingEnvironment, revenueCatWebhookSchema } from "@/lib/mobileBillingCore";
import { processMobileStoreWebhook } from "@/lib/mobileBillingService";

export async function POST(request: Request) {
  if (!mobileBillingEnabled()) return Response.json({ code: "MOBILE_BILLING_DISABLED" }, { status: 503 });
  const secret = process.env.REVENUECAT_WEBHOOK_AUTHORIZATION;
  const supplied = request.headers.get("authorization") || "";
  if (!secret || secret.length < 32 || Buffer.byteLength(secret) !== Buffer.byteLength(supplied) || !timingSafeEqual(Buffer.from(secret), Buffer.from(supplied))) {
    return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  }
  try {
    const payload = await readLimitedJson(request, 64 * 1024, revenueCatWebhookSchema);
    const expectedApp = payload.event.store === "APP_STORE" ? process.env.REVENUECAT_APPLE_APP_ID : process.env.REVENUECAT_GOOGLE_APP_ID;
    if (!expectedApp || payload.event.app_id !== expectedApp || payload.event.environment !== mobileBillingEnvironment()) {
      return Response.json({ code: "STORE_ENVIRONMENT_MISMATCH" }, { status: 400 });
    }
    if (payload.event.type !== "TEST") await processMobileStoreWebhook(payload.event);
    return Response.json({ received: true });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    console.warn("Store webhook processing failed.", { errorName: error instanceof Error ? error.name : "UnknownError" });
    return Response.json({ code: "STORE_WEBHOOK_RETRY" }, { status: 503 });
  }
}
