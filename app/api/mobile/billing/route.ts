export const dynamic = "force-dynamic";

import { requireMobileBearer } from "@/lib/mobileAuthRoute";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { mobileBillingEnabled, mobileBillingRequestSchema } from "@/lib/mobileBillingCore";
import { cancelMobileWebSubscription, cancelMobileSubscriptionPurchase, ensureMobileBillingId, prepareMobileCreditPurchase, prepareMobileSubscriptionPurchase, readMobileBillingState, syncMobileSubscription } from "@/lib/mobileBillingService";

export async function POST(request: Request) {
  if (!mobileBillingEnabled()) return Response.json({ code: "MOBILE_BILLING_DISABLED" }, { status: 503 });
  try {
    const auth = await requireMobileBearer(request);
    if (!auth.ok) return auth.response;
    await consumeApiRateLimit(request, auth.identity.userId, "mobile-billing", { minute: 12, day: 200 });
    const body = await readLimitedJson(request, 1024, mobileBillingRequestSchema);
    const billingId = await ensureMobileBillingId(auth.identity.userId);
    if (body.action === "cancel_web") await cancelMobileWebSubscription(auth.identity.userId);
    if (body.action !== "cancel_web") await syncMobileSubscription(auth.identity.userId, billingId);
    if (body.action === "prepare_credit_purchase") await prepareMobileCreditPurchase(auth.identity.userId, body.store, body.productId);
    if (body.action === "prepare_subscription_purchase") {
      await prepareMobileSubscriptionPurchase(auth.identity.userId, body.store, body.productId);
    }
    if (body.action === "cancel_subscription_purchase") await cancelMobileSubscriptionPurchase(auth.identity.userId, body.attemptId);
    return Response.json(await readMobileBillingState(auth.identity.userId, body.store), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    // Never log receipt data, app user IDs, keys, or provider response bodies.
    console.warn("Mobile billing synchronization failed.", { errorName: error instanceof Error ? error.name : "UnknownError" });
    return Response.json({ code: "STORE_VERIFICATION_UNAVAILABLE" }, { status: 503 });
  }
}
