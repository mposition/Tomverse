import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let valid = false; const calls: string[] = [];
mock.module(mod("lib/mobileAuthRoute.ts"), { namedExports: { requireMobileBearer: async () => valid
  ? { ok: true, identity: { userId: "verified-user" } } : { ok: false, response: Response.json({}, { status: 401 }) } } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  apiSecurityResponse: () => null, consumeApiRateLimit: async () => {},
  readLimitedJson: async (request: Request, _limit: number, schema: { parse: (v: unknown) => unknown }) => schema.parse(await request.json()),
} });
mock.module(mod("lib/mobileBillingService.ts"), { namedExports: {
  ensureMobileBillingId: async (id: string) => { calls.push(id); return "opaque-billing-id"; },
  syncMobileSubscription: async (id: string) => { calls.push(id); return { verificationPending: false }; },
  readMobileBillingState: async (id: string) => { calls.push(id); return { plan: "Free", verificationPending: true }; },
  cancelMobileWebSubscription: async (id: string) => { calls.push(`cancel:${id}`); },
  prepareMobileCreditPurchase: async (id: string, store: string, product: string) => { calls.push(`prepare:${id}:${store}:${product}`); },
  prepareMobileSubscriptionPurchase: async (id: string) => { calls.push(`prepare-subscription:${id}`); },
  cancelMobileSubscriptionPurchase: async (id: string) => { calls.push(`cancel-subscription:${id}`); },
  processMobileStoreWebhook: async () => { calls.push("webhook"); },
} });
const require = createRequire(import.meta.url);
const route = require(resolve(root, "app/api/mobile/billing/route.ts")) as typeof import("../../app/api/mobile/billing/route");
const webhook = require(resolve(root, "app/api/webhooks/revenuecat/route.ts")) as typeof import("../../app/api/webhooks/revenuecat/route");
const request = (action = "sync") => new Request("https://tomverse.app/api/mobile/billing", {
  method: "POST", headers: { cookie: "untrusted-cookie", "x-tomverse-user-id": "forged" }, body: JSON.stringify({ action, store: "app_store" }),
});
test("mobile billing refuses by default and authenticates bearer independently without cookie fallback", async () => {
  delete process.env.MOBILE_BILLING_ENABLED;
  assert.equal((await route.POST(request())).status, 503); assert.equal(calls.length, 0);
  process.env.MOBILE_BILLING_ENABLED = "true";
  assert.equal((await route.POST(request())).status, 401); assert.equal(calls.length, 0);
  valid = true;
  const response = await route.POST(request());
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).verificationPending, true, "fresh readback must not be overwritten by an older sync result");
  assert.deepEqual(calls, ["verified-user", "verified-user", "verified-user"]);
  calls.length = 0;
  await route.POST(request("cancel_web"));
  assert.ok(calls.includes("cancel:verified-user"));
  const prepared = await route.POST(new Request("https://tomverse.app/api/mobile/billing", {
    method: "POST", body: JSON.stringify({ action: "prepare_credit_purchase", store: "app_store", productId: "credits500" }),
  }));
  assert.equal(prepared.status, 200);
  assert.ok(calls.includes("prepare:verified-user:app_store:credits500"));
});
test("webhook requires an exact secret, configured app and environment before touching balances", async () => {
  calls.length = 0;
  process.env.REVENUECAT_WEBHOOK_AUTHORIZATION = "Bearer a-long-private-webhook-test-secret";
  process.env.REVENUECAT_APPLE_APP_ID = "app-apple";
  const event = { id: "event-1", app_id: "app-apple", app_user_id: "opaque-id", store: "APP_STORE", environment: "PRODUCTION",
    type: "NON_RENEWING_PURCHASE", product_id: "pack", transaction_id: "tx-1", purchased_at_ms: Date.now() };
  const post = (secret: string, fields = {}) => webhook.POST(new Request("https://tomverse.app/api/webhooks/revenuecat", {
    method: "POST", headers: { authorization: secret }, body: JSON.stringify({ api_version: "1.0", event: { ...event, ...fields } }),
  }));
  assert.equal((await post("forged")).status, 401);
  const secret = process.env.REVENUECAT_WEBHOOK_AUTHORIZATION;
  assert.equal((await post(secret, { environment: "SANDBOX" })).status, 200);
  assert.equal((await post(secret, { app_id: "other-project" })).status, 200);
  const transfer = await post(secret, { type: "TRANSFER", app_user_id: undefined, transaction_id: undefined, product_id: undefined, purchased_at_ms: undefined });
  assert.equal((await transfer.json()).ignored, "UNSUPPORTED_STORE_EVENT");
  assert.equal(calls.length, 0);
  assert.equal((await post(secret)).status, 200); assert.deepEqual(calls, ["webhook"]);
});
