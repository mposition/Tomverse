import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// The administrator Stripe webhook replay route, driven against a real
// PostgreSQL.
//
// Replaying a webhook re-applies whatever entitlement the event carries, so
// the two things worth proving are that a replay records itself and that a
// refused replay changes nothing.
//
// The refusal is the reason this file exists. `stripeEventMatchesKeyMode`
// stops a live event being replayed against a test key and the reverse, and
// today it is covered twice over as a pure function and once as a *source
// order* assertion in tests/goLiveSecurityFixes.ts -- "the check appears
// before processStripeEvent in the file". Source order cannot show that the
// route writes nothing when the check fails: an update placed before the
// guard, or an audit entry written on the way out, would satisfy the ordering
// assertion and still leave a mismatched replay recorded as processed.
//
// Runs in its own process under scripts/run-db-integration-tests.mjs, because
// mock.module is process-global and this file replaces next-auth, the Stripe
// client and the webhook processor for every module that imports them.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.ADMIN_EMAILS = "webhook-owner@tomverse.test";
process.env.ADMIN_OWNER_EMAILS = "webhook-owner@tomverse.test";
process.env.ADMIN_AUDIT_INTEGRITY_KEY ||= "webhook-reprocess-audit-test-key";
// A test-mode key, so an event with `livemode: true` is the mismatch the guard
// exists for. The value never leaves this process: `lib/stripe.ts` is mocked.
process.env.STRIPE_SECRET_KEY = "sk_test_webhook_reprocess_fixture";

let sessionOverride: unknown = null;
mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => sessionOverride },
});

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

/** The event the provider hands back for the id on the log row. */
let providerEvent: {
  id: string;
  type: string;
  livemode: boolean;
  data: { object: { object: string } };
} | null = null;

let eventsRetrieved: string[] = [];

mock.module(mod("lib/stripe.ts"), {
  namedExports: {
    isStripeConfigured: () => true,
    getStripe: () => ({
      events: {
        retrieve: async (id: string) => {
          eventsRetrieved.push(id);
          if (!providerEvent) throw new Error("no event fixture configured");
          return providerEvent;
        },
      },
    }),
  },
});

/** Every event the route asked the processor to apply. */
let processedEvents: string[] = [];
/** Set to make the next `processStripeEvent` throw, as a failed replay would. */
let failNextProcess = false;

mock.module(mod("lib/stripeWebhookProcessing.ts"), {
  namedExports: {
    processStripeEvent: async (event: { id: string }) => {
      if (failNextProcess) {
        failNextProcess = false;
        throw new Error("simulated webhook processing failure");
      }
      processedEvents.push(event.id);
    },
  },
});

type RouteModule = {
  POST: (
    request: Request,
    context: { params: Promise<{ webhookId: string }> }
  ) => Promise<Response>;
};
let prisma: (typeof import("@/lib/prisma"))["prisma"];
let route: RouteModule;

before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));
  route = (await import(
    mod("app/api/admin/webhooks/[webhookId]/reprocess/route.ts")
  )) as RouteModule;
});

const resetData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AdminAuditLog",
      "StripeWebhookEventLog",
      "ChatUsageBucket",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await resetData();
  sessionOverride = null;
  unexpectedHostCalls = [];
  providerEvent = null;
  eventsRetrieved = [];
  processedEvents = [];
  failNextProcess = false;
});

after(async () => {
  await resetData();
  await prisma.$disconnect();
});

const seedOwnerAdmin = async () => {
  const user = await prisma.user.create({
    data: { email: "webhook-owner@tomverse.test", lastLoginAt: new Date() },
  });
  return {
    user,
    session: {
      user: {
        id: user.id,
        email: user.email,
        name: "Webhook Owner",
        authenticatedAt: new Date().toISOString(),
      },
      expires: new Date(Date.now() + 3_600_000).toISOString(),
    },
  };
};

const seedFailedLog = (stripeEventId: string | null = "evt_replayable") =>
  prisma.stripeWebhookEventLog.create({
    data: {
      stripeEventId,
      eventType: "invoice.payment_failed",
      status: "failed",
      error: "the first attempt threw",
    },
  });

const reprocess = (webhookId: string) =>
  route.POST(
    new Request(
      `https://tomverse.test/api/admin/webhooks/${webhookId}/reprocess`,
      { method: "POST" }
    ),
    { params: Promise.resolve({ webhookId }) }
  );

test("a replay applies the event and records who replayed it", async () => {
  const { user, session } = await seedOwnerAdmin();
  const log = await seedFailedLog();
  providerEvent = {
    id: "evt_replayable",
    type: "invoice.payment_succeeded",
    livemode: false,
    data: { object: { object: "invoice" } },
  };
  sessionOverride = session;

  const response = await reprocess(log.id);
  assert.equal(response.status, 200);

  assert.deepEqual(eventsRetrieved, ["evt_replayable"]);
  assert.deepEqual(processedEvents, ["evt_replayable"]);

  const stored = await prisma.stripeWebhookEventLog.findUniqueOrThrow({
    where: { id: log.id },
  });
  assert.equal(stored.status, "processed");
  // The provider's type wins: the row was written from a first attempt that
  // may have failed before it knew what the event was.
  assert.equal(stored.eventType, "invoice.payment_succeeded");
  assert.equal(stored.error, null);
  assert.ok(stored.replayedAt);
  assert.equal(stored.replayedById, user.id);
  assert.equal(stored.replayedByEmail, user.email);
  assert.deepEqual(stored.payloadSummary, {
    object: "invoice",
    livemode: false,
    replayed: true,
  });

  const audit = await prisma.adminAuditLog.findMany();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "stripe_webhook.reprocessed");
  // The status *before* the replay. Recording the new one would make the
  // entry say only what the row already says.
  assert.equal(
    (audit[0].metadata as { previousStatus?: string } | null)?.previousStatus,
    "failed"
  );
  assert.deepEqual(unexpectedHostCalls, []);
});

test("an event from the other Stripe mode is refused and changes nothing", async () => {
  // The key is `sk_test_`, so a live event must not be replayable through it.
  // Applying it would move entitlements in this environment from a payment
  // that happened in the other one.
  const { session } = await seedOwnerAdmin();
  const log = await seedFailedLog();
  providerEvent = {
    id: "evt_replayable",
    type: "invoice.payment_succeeded",
    livemode: true,
    data: { object: { object: "invoice" } },
  };
  sessionOverride = session;

  const response = await reprocess(log.id);
  assert.equal(response.status, 409);

  assert.deepEqual(processedEvents, [], "no entitlement is applied");
  const stored = await prisma.stripeWebhookEventLog.findUniqueOrThrow({
    where: { id: log.id },
  });
  // Untouched, all of it. A refused replay that still stamped `replayedAt` or
  // flipped the status would read afterwards exactly like one that worked.
  assert.equal(stored.status, "failed");
  assert.equal(stored.error, "the first attempt threw");
  assert.equal(stored.replayedAt, null);
  assert.equal(stored.replayedById, null);
  assert.equal(stored.processedAt, null);
  assert.equal(await prisma.adminAuditLog.count(), 0);
});

test("a log row with no provider event id is refused before Stripe is called", async () => {
  const { session } = await seedOwnerAdmin();
  const log = await seedFailedLog(null);
  sessionOverride = session;

  const response = await reprocess(log.id);
  assert.equal(response.status, 400);
  assert.deepEqual(eventsRetrieved, [], "nothing is asked of the provider");
  assert.equal(await prisma.adminAuditLog.count(), 0);
});

test("a replay that fails while processing is not recorded as processed", async () => {
  const { session } = await seedOwnerAdmin();
  const log = await seedFailedLog();
  providerEvent = {
    id: "evt_replayable",
    type: "invoice.payment_succeeded",
    livemode: false,
    data: { object: { object: "invoice" } },
  };
  failNextProcess = true;
  sessionOverride = session;

  const response = await reprocess(log.id);
  assert.equal(response.status, 500);

  const stored = await prisma.stripeWebhookEventLog.findUniqueOrThrow({
    where: { id: log.id },
  });
  // The operator's queue of broken webhooks is the only place this is visible.
  // A failed replay marked `processed` removes itself from that queue.
  assert.equal(stored.status, "failed");
  assert.equal(stored.replayedAt, null);
  assert.equal(await prisma.adminAuditLog.count(), 0);
});

test("a caller without billing:write cannot replay anything", async () => {
  const user = await prisma.user.create({
    data: { email: "not-an-admin@tomverse.test", lastLoginAt: new Date() },
  });
  const log = await seedFailedLog();
  sessionOverride = {
    user: {
      id: user.id,
      email: user.email,
      name: "Not An Admin",
      authenticatedAt: new Date().toISOString(),
    },
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  };

  // 404 rather than 403: an outsider learns nothing about which ids exist.
  assert.equal((await reprocess(log.id)).status, 404);
  assert.deepEqual(eventsRetrieved, []);
  assert.deepEqual(processedEvents, []);
});
