import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// The Stripe webhook endpoint, driven against a real PostgreSQL.
//
// Stripe delivers at least once, so the endpoint's own rule about repeats is
// what stands between a retried delivery and a customer being granted the same
// entitlement twice. That rule has two halves and they pull in opposite
// directions: an event already `processed` must not be processed again, and an
// event recorded as `failed` must be, or a transient failure becomes permanent
// the moment Stripe redelivers.
//
// Both halves are invisible from the outside. A route that skipped every event
// it had a row for, and a route that skipped none, each answer 200 to the
// second delivery; the difference is whether processing ran and what the row
// says afterwards. tests/goLiveSecurityFixes.ts asserts the mode check's
// position in the source, which is a different claim from what the endpoint
// does with the database.
//
// Runs in its own process under scripts/run-db-integration-tests.mjs, because
// mock.module is process-global and this file replaces the Stripe client and
// the webhook processor for every module that imports them.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

// A test-mode key, so an event with `livemode: true` is the mismatch the guard
// exists for. Never leaves the process: `lib/stripe.ts` is mocked below.
process.env.STRIPE_SECRET_KEY = "sk_test_webhook_route_fixture";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fixture";

/** Nothing here may reach the network; this catches anything that tries. */
let unexpectedHostCalls: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  unexpectedHostCalls.push(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : String((input as Request).url)
  );
  return new Response(null, { status: 204 });
}) as typeof fetch;

type FakeEvent = {
  id: string;
  type: string;
  livemode: boolean;
  data: { object: { object: string } };
};

/** What `constructEvent` returns, or an error it throws for a bad signature. */
let constructedEvent: FakeEvent | null = null;
let signatureError: Error | null = null;
let constructEventCalls = 0;

mock.module(mod("lib/stripe.ts"), {
  namedExports: {
    isStripeConfigured: () => true,
    getStripe: () => ({
      webhooks: {
        constructEvent: () => {
          constructEventCalls += 1;
          if (signatureError) throw signatureError;
          if (!constructedEvent) throw new Error("no event fixture configured");
          return constructedEvent;
        },
      },
    }),
  },
});

/** Every event the route asked the processor to apply. */
let processedEvents: string[] = [];
/** Set to make the next `processStripeEvent` throw, as a bad handler would. */
let failNextProcess: Error | null = null;

mock.module(mod("lib/stripeWebhookProcessing.ts"), {
  namedExports: {
    processStripeEvent: async (event: { id: string }) => {
      if (failNextProcess) {
        const error = failNextProcess;
        failNextProcess = null;
        throw error;
      }
      processedEvents.push(event.id);
    },
  },
});

type RouteModule = { POST: (request: Request) => Promise<Response> };
let prisma: (typeof import("@/lib/prisma"))["prisma"];
let route: RouteModule;

before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));
  route = (await import(
    mod("app/api/billing/webhook/route.ts")
  )) as RouteModule;
});

const resetData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "StripeWebhookEventLog" RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await resetData();
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_fixture";
  unexpectedHostCalls = [];
  constructedEvent = null;
  signatureError = null;
  constructEventCalls = 0;
  processedEvents = [];
  failNextProcess = null;
});

after(async () => {
  await resetData();
  await prisma.$disconnect();
});

const deliver = (options: { signature?: string | null } = {}) => {
  const signature =
    options.signature === undefined ? "t=1,v1=fixture" : options.signature;
  return route.POST(
    new Request("https://tomverse.test/api/billing/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(signature ? { "stripe-signature": signature } : {}),
      },
      body: JSON.stringify({ id: "evt_body" }),
    })
  );
};

const testModeEvent = (id = "evt_1"): FakeEvent => ({
  id,
  type: "checkout.session.completed",
  livemode: false,
  data: { object: { object: "checkout.session" } },
});

const logFor = (stripeEventId: string) =>
  prisma.stripeWebhookEventLog.findUniqueOrThrow({ where: { stripeEventId } });

/* ------------------------------------------- at-least-once delivery ------- */

test("a redelivered event that already succeeded is not processed again", async () => {
  // The invariant the endpoint exists to hold. Stripe retries deliveries, and
  // applying `checkout.session.completed` twice grants the entitlement twice.
  constructedEvent = testModeEvent();

  assert.equal((await deliver()).status, 200);
  assert.deepEqual(processedEvents, ["evt_1"]);
  const first = await logFor("evt_1");
  assert.equal(first.status, "processed");

  const second = await deliver();
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { received: true, duplicate: true });
  assert.deepEqual(
    processedEvents,
    ["evt_1"],
    "the second delivery must not re-apply the event"
  );

  // The row is answered from, not rewritten: a second `processedAt` would
  // misdate when the entitlement was actually applied.
  const after = await logFor("evt_1");
  assert.deepEqual(after.processedAt, first.processedAt);
  assert.deepEqual(unexpectedHostCalls, []);
});

test("a redelivered event that failed is processed again", async () => {
  // The other half of the same rule, and the one a too-broad skip would break:
  // skipping every event with a row would make one transient failure
  // permanent, because Stripe's redelivery is the only retry there is.
  constructedEvent = testModeEvent("evt_retry");
  failNextProcess = new Error("handler blew up");

  assert.equal((await deliver()).status, 500);
  const failed = await logFor("evt_retry");
  assert.equal(failed.status, "failed");
  assert.deepEqual(processedEvents, []);

  assert.equal((await deliver()).status, 200);
  assert.deepEqual(processedEvents, ["evt_retry"]);
  assert.equal((await logFor("evt_retry")).status, "processed");
  // The failure text from the first attempt must not survive a success.
  assert.equal((await logFor("evt_retry")).error, null);
});

test("a failure is recorded without the provider's own words", async () => {
  // The log is read by operators and shipped to dashboards. A raw provider
  // message can carry customer identifiers or card detail, so the row keeps a
  // classification instead.
  constructedEvent = testModeEvent("evt_failed");
  failNextProcess = new Error("card_declined for customer cus_12345 <secret>");

  assert.equal((await deliver()).status, 500);
  const stored = await logFor("evt_failed");
  assert.equal(stored.status, "failed");
  assert.ok(stored.error, "a failure says something");
  assert.ok(
    !stored.error?.includes("cus_12345"),
    `the raw provider message must not be stored: ${stored.error}`
  );
});

/* ------------------------------------------------- refusals, before writes */

test("a signed event from the other Stripe mode is refused with no row at all", async () => {
  // The key is `sk_test_`, so a live event is the mismatch. Refusing after the
  // upsert would leave a row an operator could replay by hand.
  constructedEvent = { ...testModeEvent("evt_live"), livemode: true };

  const response = await deliver();
  assert.equal(response.status, 400);
  assert.deepEqual(processedEvents, []);
  assert.equal(
    await prisma.stripeWebhookEventLog.count(),
    0,
    "a mismatched event leaves nothing behind"
  );
});

test("an unsigned request is refused before Stripe is asked anything", async () => {
  const response = await deliver({ signature: null });
  assert.equal(response.status, 503);
  assert.equal(constructEventCalls, 0);
  assert.equal(await prisma.stripeWebhookEventLog.count(), 0);
});

test("a request with no configured secret is refused the same way", async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const response = await deliver();
  assert.equal(response.status, 503);
  assert.equal(constructEventCalls, 0);
});

test("a bad signature is refused and recorded nowhere", async () => {
  signatureError = new Error("No signatures found matching the expected signature");

  const response = await deliver();
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid signature." });
  assert.deepEqual(processedEvents, []);
  assert.equal(await prisma.stripeWebhookEventLog.count(), 0);
});
