import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// The administrator refund decision route, driven end to end against a real
// PostgreSQL.
//
// The claim under test is narrow and load-bearing: a refund decision, the
// audit entry naming who made it, and the outbox row saying the customer is
// owed a decision email all commit together, or none of them do.
//
// They used to commit in three separate transactions. A failure after the
// first left a refund approved with no record of the approver and no queued
// mail -- and because the route refused any retry with 409, neither could be
// recovered. That is the shape these tests pin, from both sides: the rollback
// when the outbox write fails, and the idempotent replay when the response is
// lost after everything committed.
//
// Runs in its own process under scripts/run-db-integration-tests.mjs, because
// mock.module is process-global and this file replaces both next-auth and the
// notification queue for every module that imports them.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.ADMIN_EMAILS = "refund-owner@tomverse.test";
process.env.ADMIN_OWNER_EMAILS = "refund-owner@tomverse.test";
// The audit chain only computes an entry hash when a secret is configured; set
// one so the persisted row is the fully-formed shape production writes.
process.env.ADMIN_AUDIT_INTEGRITY_KEY ||= "refund-decision-audit-test-key";
// No Stripe: with no key and no subscription id, the refund helper returns
// empty values without making a call, which is what keeps this test offline.
delete process.env.STRIPE_SECRET_KEY;

// --- session seam ----------------------------------------------------------
let sessionOverride: unknown = null;
mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => sessionOverride },
});

// Nothing in this file may reach the network. Resend is never configured here,
// so the inline delivery attempt resolves as "not configured" without a call;
// this catches anything that tries anyway.
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

type RouteModule = {
  PATCH: (
    request: Request,
    context: { params: Promise<{ requestId: string }> }
  ) => Promise<Response>;
};
let prisma: (typeof import("@/lib/prisma"))["prisma"];
let route: RouteModule;

/**
 * Set to make the next outbox write fail, standing in for any database error
 * in that statement. The route must roll the decision back with it.
 */
let failNextEnqueue = false;

before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));

  // Wrap the real queue rather than replace it: the decision transaction has
  // to write a genuine NotificationDelivery row for the "exactly one row"
  // assertions to mean anything.
  const real = (await import(
    mod("lib/notificationDeliveries.ts")
  )) as typeof import("@/lib/notificationDeliveries");
  mock.module(mod("lib/notificationDeliveries.ts"), {
    namedExports: {
      ...real,
      enqueueNotificationDelivery: async (
        ...args: Parameters<typeof real.enqueueNotificationDelivery>
      ) => {
        if (failNextEnqueue) {
          failNextEnqueue = false;
          throw new Error("simulated notification queue write failure");
        }
        return real.enqueueNotificationDelivery(...args);
      },
    },
  });

  route = (await import(
    mod("app/api/admin/refund-requests/[requestId]/route.ts")
  )) as RouteModule;
});

const resetRefundData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AdminAuditLog",
      "NotificationDelivery",
      "RefundRequestTimelineEvent",
      "RefundRequest",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await resetRefundData();
  unexpectedHostCalls = [];
  sessionOverride = null;
  failNextEnqueue = false;
});

after(async () => {
  await resetRefundData();
  await prisma.$disconnect();
});

const seedOwnerAdmin = async () => {
  const user = await prisma.user.create({
    data: { email: "refund-owner@tomverse.test", lastLoginAt: new Date() },
  });
  return {
    user,
    session: {
      user: {
        id: user.id,
        email: user.email,
        name: "Refund Owner",
        authenticatedAt: new Date().toISOString(),
      },
      expires: new Date(Date.now() + 3_600_000).toISOString(),
    },
  };
};

/**
 * A customer with a pending request and no Stripe subscription, so the approve
 * path takes the "nothing to refund at the provider" branch and stays offline.
 */
const seedPendingRequest = async () => {
  const customer = await prisma.user.create({
    data: { email: `customer-${Date.now()}@tomverse.test`, plan: "Pro" },
  });
  return prisma.refundRequest.create({
    data: {
      userId: customer.id,
      email: customer.email,
      plan: "Pro",
      stripeSubscriptionId: null,
      status: "pending",
    },
  });
};

const patch = (requestId: string, body: unknown) =>
  route.PATCH(
    new Request(`https://tomverse.test/api/admin/refund-requests/${requestId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ requestId }) }
  );

const deliveriesFor = (referenceId: string) =>
  prisma.notificationDelivery.findMany({ where: { referenceId } });

test("a rejection commits its decision, its audit entry and its outbox row together", async () => {
  const { session } = await seedOwnerAdmin();
  const request = await seedPendingRequest();
  sessionOverride = session;

  const response = await patch(request.id, {
    action: "reject",
    adminNote: "Outside the refund window.",
  });
  assert.equal(response.status, 200);

  const stored = await prisma.refundRequest.findUniqueOrThrow({
    where: { id: request.id },
  });
  assert.equal(stored.status, "rejected");

  const audits = await prisma.adminAuditLog.findMany({
    where: { action: "refund.rejected", targetId: request.id },
  });
  assert.equal(audits.length, 1);
  // Written inside the decision transaction, but still a fully-formed chained
  // entry rather than a degraded one.
  assert.ok(audits[0]!.entryHash);

  const deliveries = await deliveriesFor(request.id);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.kind, "refund_request_rejected");
  assert.deepEqual(unexpectedHostCalls, []);
});

test("an approval commits its decision, its audit entry and its outbox row together", async () => {
  const { session } = await seedOwnerAdmin();
  const request = await seedPendingRequest();
  sessionOverride = session;

  const response = await patch(request.id, { action: "approve" });
  assert.equal(response.status, 200);

  const stored = await prisma.refundRequest.findUniqueOrThrow({
    where: { id: request.id },
  });
  assert.equal(stored.status, "approved");
  assert.equal(
    (await prisma.adminAuditLog.count({
      where: { action: "refund.approved", targetId: request.id },
    })),
    1
  );

  const deliveries = await deliveriesFor(request.id);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.kind, "refund_request_approved");
  assert.deepEqual(unexpectedHostCalls, []);
});

test("a failed outbox write rolls the whole decision back, leaving it retryable", async () => {
  const { session } = await seedOwnerAdmin();
  const request = await seedPendingRequest();
  sessionOverride = session;

  failNextEnqueue = true;
  const failed = await patch(request.id, { action: "reject" });
  assert.equal(failed.status, 500);

  // The defect this pins: none of these may survive the failed enqueue.
  const afterFailure = await prisma.refundRequest.findUniqueOrThrow({
    where: { id: request.id },
  });
  assert.equal(afterFailure.status, "pending");
  assert.equal(afterFailure.reviewedAt, null);
  assert.equal(await prisma.adminAuditLog.count(), 0);
  assert.equal(await prisma.refundRequestTimelineEvent.count(), 0);
  assert.equal((await deliveriesFor(request.id)).length, 0);

  // And because nothing was decided, the operator can simply try again.
  const retried = await patch(request.id, { action: "reject" });
  assert.equal(retried.status, 200);
  assert.equal(
    (await prisma.refundRequest.findUniqueOrThrow({ where: { id: request.id } }))
      .status,
    "rejected"
  );
  assert.equal((await deliveriesFor(request.id)).length, 1);
  assert.equal(await prisma.adminAuditLog.count(), 1);
});

test("replaying the same decision succeeds without deciding twice", async () => {
  const { session } = await seedOwnerAdmin();
  const request = await seedPendingRequest();
  sessionOverride = session;

  assert.equal((await patch(request.id, { action: "reject" })).status, 200);
  const first = await prisma.refundRequest.findUniqueOrThrow({
    where: { id: request.id },
  });

  // The lost-response case: the administrator sends the same decision again.
  const replay = await patch(request.id, { action: "reject" });
  assert.equal(replay.status, 200);
  const payload = (await replay.json()) as { replayed?: boolean };
  assert.equal(payload.replayed, true);

  const second = await prisma.refundRequest.findUniqueOrThrow({
    where: { id: request.id },
  });
  // Nothing about the decision moved: not the timestamp, not the reviewer.
  assert.deepEqual(second.reviewedAt, first.reviewedAt);
  assert.equal(second.status, "rejected");
  // One decision, one audit entry, one queue row -- the unique constraint on
  // (kind, referenceId) is what makes the replay safe to repeat.
  assert.equal(await prisma.adminAuditLog.count(), 1);
  assert.equal(await prisma.refundRequestTimelineEvent.count(), 1);
  assert.equal((await deliveriesFor(request.id)).length, 1);
});

test("a replay reinstates an outbox row that an earlier decision never wrote", async () => {
  const { session } = await seedOwnerAdmin();
  const request = await seedPendingRequest();
  sessionOverride = session;

  assert.equal((await patch(request.id, { action: "approve" })).status, 200);
  // Stands in for a row decided before the enqueue joined the transaction:
  // the decision is on record, the notification it owes is not.
  await prisma.notificationDelivery.deleteMany({
    where: { referenceId: request.id },
  });
  assert.equal((await deliveriesFor(request.id)).length, 0);

  const replay = await patch(request.id, { action: "approve" });
  assert.equal(replay.status, 200);
  const deliveries = await deliveriesFor(request.id);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.kind, "refund_request_approved");
});

test("the opposite decision on a reviewed request is still refused", async () => {
  const { session } = await seedOwnerAdmin();
  const request = await seedPendingRequest();
  sessionOverride = session;

  assert.equal((await patch(request.id, { action: "reject" })).status, 200);

  const reversal = await patch(request.id, { action: "approve" });
  assert.equal(reversal.status, 409);
  assert.equal(
    (await prisma.refundRequest.findUniqueOrThrow({ where: { id: request.id } }))
      .status,
    "rejected"
  );
  // The refused reversal wrote nothing at all.
  assert.equal(await prisma.adminAuditLog.count(), 1);
  const deliveries = await deliveriesFor(request.id);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.kind, "refund_request_rejected");
});
