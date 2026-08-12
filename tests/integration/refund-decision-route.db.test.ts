import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
// Pure constants; nothing here is behind a module mock.
import { REFUND_REQUEST_METADATA_KEY } from "@/lib/refundSagaCore";

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

/**
 * The request's status at the instant the payment provider was called.
 *
 * This is the only place the pre-Stripe claim is observable: the claim exists
 * precisely so that, while money may be moving, the row already says so. A
 * decision that only claims inside its own transaction looks identical
 * afterwards and differs only here.
 */
let statusWhenProviderCalled: string | null = null;
let providerSubscriptionId: string | null = null;
let stripeConfigured = false;

/**
 * The charge the provider holds, or `null` for "no invoice at all".
 *
 * `null` is the offline default every pre-existing test in this file runs on:
 * the approval path returns `no_payment_intent` and nothing can be refunded.
 * Setting it is what opens the paths where money actually moves, and those are
 * the ones the amount arithmetic lives on.
 */
let providerCharge:
  | { id: string; amount: number; amount_refunded: number; currency: string }
  | null = null;

/** Refunds the provider already holds for that charge, as `refunds.list` returns them. */
let providerExistingRefunds: Array<{
  id: string;
  status: string;
  amount: number;
  currency: string;
  charge: string;
  metadata: Record<string, string>;
}> = [];

/** Every `refunds.create` this file's double was asked to make. */
let refundsCreated: Array<{
  charge: unknown;
  amount: unknown;
  metadata: Record<string, string>;
  idempotencyKey: string | undefined;
}> = [];

/**
 * The audit actions on record at the instant `refunds.create` was called.
 *
 * Same shape of evidence as `statusWhenProviderCalled`, for the same reason:
 * `refund.execution_started` is written *before* the provider call so that a
 * crash mid-refund leaves a trail pointing at it. Read afterwards, an entry
 * written before and an entry written after look identical.
 */
let auditActionsWhenRefundCreated: string[] = [];

mock.module(mod("lib/stripe.ts"), {
  namedExports: {
    isStripeConfigured: () => stripeConfigured,
    getStripe: () => ({
      subscriptions: {
        retrieve: async () => {
          const row = await prisma.refundRequest.findFirst({
            where: { stripeSubscriptionId: providerSubscriptionId },
            select: { status: true },
          });
          statusWhenProviderCalled = row?.status ?? null;
          return {
            latest_invoice: providerCharge
              ? { payment_intent: `pi_for_${providerCharge.id}` }
              : null,
          };
        },
        cancel: async () => ({}),
      },
      invoices: { retrieve: async () => null },
      charges: {
        list: async () => ({ data: providerCharge ? [providerCharge] : [] }),
      },
      refunds: {
        list: async () => ({ data: providerExistingRefunds, has_more: false }),
        create: async (
          params: { charge: unknown; amount: unknown; metadata: Record<string, string> },
          options?: { idempotencyKey?: string }
        ) => {
          auditActionsWhenRefundCreated = (
            await prisma.adminAuditLog.findMany({ select: { action: true } })
          ).map((row) => row.action);
          refundsCreated.push({
            charge: params.charge,
            amount: params.amount,
            metadata: params.metadata,
            idempotencyKey: options?.idempotencyKey,
          });
          return {
            id: `re_created_${refundsCreated.length}`,
            status: "succeeded",
          };
        },
      },
    }),
  },
});

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
  statusWhenProviderCalled = null;
  providerSubscriptionId = null;
  stripeConfigured = false;
  providerCharge = null;
  providerExistingRefunds = [];
  refundsCreated = [];
  auditActionsWhenRefundCreated = [];
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

// --- the Stripe boundary -----------------------------------------------------
//
// The refund itself happens at Stripe, outside any transaction this process can
// hold. `processing` is what makes that survivable: it is claimed before the
// provider is called and left only after the local commit, so a crash in
// between leaves a row that says "money may have moved and nobody wrote it
// down" -- rather than a `pending` row that the next attempt would refund
// again.
//
// Stripe is not configured in this file, so the approve path takes the "nothing
// to refund at the provider" branch and the claim/release sequencing is what is
// under test.

test("the request is already claimed when the payment provider is called", async () => {
  const { session } = await seedOwnerAdmin();
  const customer = await prisma.user.create({
    data: { email: `claim-${Date.now()}@tomverse.test`, plan: "Pro" },
  });
  providerSubscriptionId = `sub_claim_${Date.now()}`;
  const request = await prisma.refundRequest.create({
    data: {
      userId: customer.id,
      email: customer.email,
      plan: "Pro",
      stripeSubscriptionId: providerSubscriptionId,
      status: "pending",
    },
  });
  stripeConfigured = true;
  sessionOverride = session;

  assert.equal((await patch(request.id, { action: "approve" })).status, 200);

  // The invariant the whole saga rests on. If the row were still `pending`
  // here, a crash after the refund left it open for a second approval -- and a
  // second refund.
  assert.equal(
    statusWhenProviderCalled,
    "processing",
    "the refund request must be claimed before the payment provider is called"
  );

  const stored = await prisma.refundRequest.findUniqueOrThrow({
    where: { id: request.id },
  });
  assert.equal(stored.status, "approved");
  // A claim that outlived its decision would be picked up by reconciliation as
  // an abandoned attempt.
  assert.equal(stored.processingStartedAt, null);
});

test("a request being processed is refused rather than retried", async () => {
  const { session } = await seedOwnerAdmin();
  const request = await seedPendingRequest();
  sessionOverride = session;

  // Stand in for an attempt that reached Stripe and has not come back.
  await prisma.refundRequest.update({
    where: { id: request.id },
    data: { status: "processing", processingStartedAt: new Date() },
  });

  const response = await patch(request.id, { action: "approve" });
  assert.equal(response.status, 409);
  const payload = (await response.json()) as { error?: string };
  // The refusal has to say why, or an operator reads it as "already reviewed"
  // and goes looking for a decision that does not exist yet.
  assert.match(payload.error || "", /processed|reconcil/i);

  // Untouched: this is the state reconciliation needs to find.
  const stored = await prisma.refundRequest.findUniqueOrThrow({
    where: { id: request.id },
  });
  assert.equal(stored.status, "processing");
  assert.equal(await prisma.adminAuditLog.count(), 0);
  assert.equal((await deliveriesFor(request.id)).length, 0);
});

test("reconciliation releases a stale claim when the provider holds no refund", async () => {
  const { reconcileProcessingRefundRequests } = (await import(
    mod("lib/refundReconciliation.ts")
  )) as typeof import("@/lib/refundReconciliation");

  const request = await seedPendingRequest();
  const startedAt = new Date(Date.now() - 30 * 60_000);
  await prisma.refundRequest.update({
    where: { id: request.id },
    data: { status: "processing", processingStartedAt: startedAt },
  });

  // Stripe is not configured here, so the pass cannot ask and must not guess.
  const skipped = await reconcileProcessingRefundRequests({ limit: 10 });
  assert.equal(skipped.examined, 1);
  assert.equal(skipped.unresolved, 1);
  assert.equal(skipped.released, 0);
  assert.equal(
    (await prisma.refundRequest.findUniqueOrThrow({ where: { id: request.id } }))
      .status,
    "processing",
    "an unreachable provider must leave the row exactly as it is"
  );
});

test("reconciliation leaves a claim that is still inside its window", async () => {
  const { reconcileProcessingRefundRequests } = (await import(
    mod("lib/refundReconciliation.ts")
  )) as typeof import("@/lib/refundReconciliation");

  const request = await seedPendingRequest();
  await prisma.refundRequest.update({
    where: { id: request.id },
    data: { status: "processing", processingStartedAt: new Date() },
  });

  const result = await reconcileProcessingRefundRequests({ limit: 10 });
  assert.equal(result.waiting, 1);
  assert.equal(result.released, 0);
  assert.equal(result.completed, 0);
  // No Stripe call is made for a request still in flight, which is also why a
  // healthy queue costs nothing.
  assert.deepEqual(unexpectedHostCalls, []);
});

/* ------------------------------------------- the path where money moves --- */

/**
 * Everything above this line runs with no charge at the provider, so the
 * approval path returns `no_payment_intent` and the amount arithmetic is never
 * reached. That arithmetic is the part that decides how much of a customer's
 * money goes back, and it had no coverage at any tier: the admin E2E harness
 * cannot reach it (docs/qa/e2e-coverage-matrix.md lists it as excluded, for
 * want of a Stripe fixture boundary), and this file stopped short of it.
 *
 * The four cases below are the ones where being wrong costs money in a
 * direction nobody notices from a green test: refunding too much, refunding
 * twice, or refunding an already-refunded charge.
 */

const seedRefundableRequest = async (
  charge: { amount: number; amount_refunded: number } = {
    amount: 5_000,
    amount_refunded: 0,
  }
) => {
  const customer = await prisma.user.create({
    data: { email: `refundable-${Date.now()}-${Math.trunc(performance.now())}@tomverse.test`, plan: "Pro" },
  });
  providerSubscriptionId = `sub_refundable_${customer.id}`;
  providerCharge = {
    id: `ch_${customer.id}`,
    currency: "usd",
    ...charge,
  };
  stripeConfigured = true;
  return prisma.refundRequest.create({
    data: {
      userId: customer.id,
      email: customer.email,
      plan: "Pro",
      stripeSubscriptionId: providerSubscriptionId,
      status: "pending",
    },
  });
};

test("an approval refunds the outstanding amount and stores what the provider returned", async () => {
  const { session } = await seedOwnerAdmin();
  // Under ADMIN_REFUND_APPROVAL_THRESHOLD_CENTS' 10,000 default, so this is
  // the ordinary single-approver path rather than the two-person one.
  const request = await seedRefundableRequest();
  sessionOverride = session;

  assert.equal((await patch(request.id, { action: "approve" })).status, 200);

  assert.equal(refundsCreated.length, 1, "exactly one refund is created");
  const created = refundsCreated[0];
  assert.equal(created.amount, 5_000);
  assert.equal(created.charge, `ch_${request.userId}`);
  // Without the request id in metadata, a refund that succeeded while the
  // local write failed could not be matched back to anything, and
  // reconciliation would have nothing to look for.
  assert.equal(created.metadata[REFUND_REQUEST_METADATA_KEY], request.id);
  // Scoped to the request: a retry inside Stripe's replay window is answered
  // from the first call instead of issuing a second refund.
  assert.ok(created.idempotencyKey, "the create carries an idempotency key");

  // The trail exists *before* the money moves, which is the only ordering that
  // helps someone reading it after a crash mid-refund.
  assert.ok(
    auditActionsWhenRefundCreated.includes("refund.execution_started"),
    `refund.execution_started must precede the provider call; audit held ${auditActionsWhenRefundCreated.join(", ")}`
  );

  const stored = await prisma.refundRequest.findUniqueOrThrow({
    where: { id: request.id },
  });
  assert.equal(stored.status, "approved");
  assert.equal(stored.stripeRefundId, "re_created_1");
  assert.equal(stored.stripeRefundStatus, "succeeded");
  assert.equal(stored.stripeChargeId, `ch_${request.userId}`);
  assert.equal(stored.refundAmountCents, 5_000);
  // Stored uppercase, whatever case the provider reports.
  assert.equal(stored.refundCurrency, "USD");
  assert.equal(stored.processingStartedAt, null);

  assert.equal((await deliveriesFor(request.id)).length, 1);
  assert.deepEqual(unexpectedHostCalls, []);
});

test("a partly refunded charge is refunded only for the remainder", async () => {
  const { session } = await seedOwnerAdmin();
  const request = await seedRefundableRequest({
    amount: 5_000,
    amount_refunded: 2_000,
  });
  sessionOverride = session;

  assert.equal((await patch(request.id, { action: "approve" })).status, 200);

  // The arithmetic is `charge.amount - charge.amount_refunded`. Refunding the
  // full charge here would hand back 2,000 cents the customer already has.
  assert.equal(refundsCreated.length, 1);
  assert.equal(refundsCreated[0].amount, 3_000);
  assert.equal(
    (await prisma.refundRequest.findUniqueOrThrow({ where: { id: request.id } }))
      .refundAmountCents,
    3_000
  );
});

test("a fully refunded charge creates no refund at all", async () => {
  const { session } = await seedOwnerAdmin();
  const request = await seedRefundableRequest({
    amount: 5_000,
    amount_refunded: 5_000,
  });
  sessionOverride = session;

  assert.equal((await patch(request.id, { action: "approve" })).status, 200);

  assert.deepEqual(refundsCreated, [], "nothing is refunded twice");
  const stored = await prisma.refundRequest.findUniqueOrThrow({
    where: { id: request.id },
  });
  // The decision still stands and still says why no money moved; reporting a
  // refund id here would be a claim the provider cannot corroborate.
  assert.equal(stored.status, "approved");
  assert.equal(stored.stripeRefundId, null);
  assert.equal(stored.stripeRefundStatus, "already_refunded");
  assert.equal(stored.refundAmountCents, 0);
});

test("a refund already at the provider for this request is adopted, not repeated", async () => {
  const { session } = await seedOwnerAdmin();
  const request = await seedRefundableRequest();
  // What a retry after Stripe's 24-hour idempotency window looks like: the key
  // has expired, so to Stripe the second call would be an ordinary new refund.
  // Metadata does not expire, which is what makes the first one findable.
  providerExistingRefunds = [
    {
      id: "re_already_there",
      status: "pending",
      amount: 5_000,
      currency: "usd",
      charge: `ch_${request.userId}`,
      metadata: { [REFUND_REQUEST_METADATA_KEY]: request.id },
    },
  ];
  sessionOverride = session;

  assert.equal((await patch(request.id, { action: "approve" })).status, 200);

  assert.deepEqual(refundsCreated, [], "the existing refund is adopted");
  const stored = await prisma.refundRequest.findUniqueOrThrow({
    where: { id: request.id },
  });
  assert.equal(stored.stripeRefundId, "re_already_there");
  assert.equal(stored.stripeRefundStatus, "pending");
  assert.equal(stored.refundAmountCents, 5_000);
});
