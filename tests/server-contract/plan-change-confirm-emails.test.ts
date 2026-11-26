import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// The plan-change confirm and settlement, driven against an in-memory account
// store and a fake Stripe: one Stripe schedule per quote however many confirms
// race, the confirmation email committed with the row that moved, and no
// schedule left behind that nothing records (docs/policy/plan-change.md
// sections 9 and "동시 확정").

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;

type Row = Record<string, unknown> & { id: string; status: string };
const PERIOD_END = Math.floor(Date.parse("2026-12-20T00:00:00Z") / 1000);
const PERIOD_START = PERIOD_END - 30 * 24 * 3600;

const price = (tier: "pro" | "max") => ({
  id: `price_${tier}_m`,
  currency: "usd",
  product: `prod_${tier}`,
  recurring: { interval: "month", interval_count: 1 },
  tax_behavior: "exclusive",
});

const world = {
  rows: new Map<string, Row>(),
  emails: [] as { templateKey: string; inTransaction: boolean; referenceId?: string }[],
  scheduleCreates: 0,
  releases: [] as string[],
  failEnqueue: false,
  failRetrieve: false,
  subscription: {} as Record<string, unknown>,
};

const reset = () => {
  world.rows.clear();
  world.emails = [];
  world.scheduleCreates = 0;
  world.releases = [];
  world.failEnqueue = false;
  world.failRetrieve = false;
  world.subscription = {
    id: "sub_1",
    status: "active",
    currency: "usd",
    cancel_at_period_end: false,
    pending_update: null,
    schedule: null,
    metadata: {},
    items: { data: [{ id: "si_1", price: price("max"), current_period_end: PERIOD_END }] },
  };
};

const matches = (row: Row, where: Record<string, unknown>) =>
  Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === "object" && "in" in (expected as object)) {
      return (expected as { in: unknown[] }).in.includes(row[key]);
    }
    return (row[key] ?? null) === expected;
  });

const planChangeRequest = {
  findFirst: async ({ where }: { where: Record<string, unknown> }) =>
    [...world.rows.values()].find((row) => matches(row, where)) ?? null,
  findUnique: async ({ where }: { where: { id: string } }) => world.rows.get(where.id) ?? null,
  findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
    const row = world.rows.get(where.id);
    if (!row) throw new Error("not found");
    return row;
  },
  findMany: async ({ where }: { where: Record<string, unknown> }) =>
    [...world.rows.values()].filter((row) => matches(row, where)),
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    let count = 0;
    for (const row of world.rows.values()) {
      if (matches(row, where)) {
        Object.assign(row, data);
        count += 1;
      }
    }
    return { count };
  },
  update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const row = world.rows.get(where.id)!;
    Object.assign(row, data);
    return row;
  },
};
const client = {
  planChangeRequest,
  // One account: read both as the subscription owner and as the email recipient.
  user: {
    findUnique: async () => ({ id: "user_1", stripeSubscriptionId: "sub_1", email: "person@example.test", settings: { language: "en" } }),
  },
};
const prisma = {
  ...client,
  // All-or-nothing, as a database transaction is: a throw restores every row.
  $transaction: async <T>(body: (tx: typeof client & { __tx: true }) => Promise<T>) => {
    const before = new Map([...world.rows].map(([id, row]) => [id, { ...row }]));
    try {
      return await body({ ...client, __tx: true });
    } catch (error) {
      world.rows.clear();
      for (const [id, row] of before) world.rows.set(id, row);
      throw error;
    }
  },
};

mock.module(mod("lib/prisma.ts"), { namedExports: { prisma } });
mock.module(mod("lib/standardEmailLane.ts"), {
  namedExports: {
    enqueueStandardEmail: async (input: { templateKey: string; tx?: { __tx?: true }; referenceId?: string }) => {
      if (world.failEnqueue) throw new Error("outbox write failed");
      world.emails.push({ templateKey: input.templateKey, inTransaction: Boolean(input.tx?.__tx), referenceId: input.referenceId });
      return { eventId: "e", deliveryId: "d", idempotencyKey: "k" };
    },
  },
});
mock.module(mod("lib/operationalMonitoring.ts"), {
  namedExports: { reportOperationalIncident: async () => {} },
});
mock.module(mod("lib/billingConfig.ts"), {
  namedExports: {
    getBillingPlans: async () => [
      { id: "pro", tier: "Pro", stripeProductId: "prod_pro", monthlyMessageLimit: 3000 },
      { id: "max", tier: "Max", stripeProductId: "prod_max", monthlyMessageLimit: 10000 },
    ],
    getBillingPlanByTier: async (tier: string) => ({ tier, monthlyMessageLimit: tier === "Max" ? 10000 : 3000 }),
  },
});
mock.module(mod("lib/chatSecurity.ts"), { namedExports: { getUserChatUsageKey: () => "usage" } });
mock.module(mod("lib/chatUsageBucketCount.ts"), { namedExports: { usageBucketCount: async () => 0 } });
mock.module(mod("lib/stripe.ts"), {
  namedExports: {
    isStripeConfigured: () => true,
    getStripe: () => ({
      subscriptions: {
        retrieve: async () => {
          if (world.failRetrieve) throw new Error("stripe unavailable");
          return structuredClone(world.subscription);
        },
      },
      prices: { list: async () => ({ data: [price("pro")] }) },
      subscriptionSchedules: {
        create: async () => {
          world.scheduleCreates += 1;
          // Attaching a schedule changes what the subscription reads as.
          world.subscription.schedule = "sub_sched_1";
          return {
            id: "sub_sched_1",
            phases: [{ items: [{ price: "price_max_m", quantity: 1 }], start_date: PERIOD_START, end_date: PERIOD_END }],
          };
        },
        update: async () => ({ id: "sub_sched_1" }),
        release: async (id: string) => {
          world.releases.push(id);
          world.subscription.schedule = null;
          return { id };
        },
      },
    }),
  },
});

const load = async () => {
  const service = await import(mod("lib/planChangeService.ts"));
  const machine = await import(mod("lib/planChangeStateMachine.ts"));
  return { ...service, planChangeStateFingerprint: machine.planChangeStateFingerprint };
};

/** A Max -> Pro quote for the subscription as it reads now. */
const quoteDowngrade = async () => {
  const { snapshotFromStripeSubscription, planChangeStateFingerprint } = await load();
  const snapshot = await snapshotFromStripeSubscription(structuredClone(world.subscription));
  world.rows.set("pcr_1", {
    id: "pcr_1",
    userId: "user_1",
    direction: "downgrade",
    execution: "scheduled_downgrade",
    fromTier: "Max",
    toTier: "Pro",
    billingInterval: "monthly",
    currency: "usd",
    stripeSubscriptionId: "sub_1",
    stripeSubscriptionItemId: "si_1",
    targetStripePriceId: "price_pro_m",
    fingerprint: planChangeStateFingerprint(snapshot),
    renewalDecision: "unaffected",
    status: "previewed",
    confirmedAt: null,
    stripeScheduleId: null,
    appliesAt: new Date(PERIOD_END * 1000),
    pendingForUserId: null,
    createdAt: new Date(),
  });
};

mock.module(mod("lib/planChangeCredits.ts"), {
  namedExports: { planCreditsAfterPlanChange: () => ({ monthlyPlanCredits: 0, remainingPlanCredits: 0, overageCredits: 0 }) },
});

test("a confirmed downgrade attaches one schedule and commits its email with the row", async () => {
  reset();
  await quoteDowngrade();
  const { confirmPlanChange } = await load();
  const result = await confirmPlanChange({ userId: "user_1", requestId: "pcr_1" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(world.scheduleCreates, 1);
  assert.equal(world.rows.get("pcr_1")!.status, "pending");
  assert.equal(world.rows.get("pcr_1")!.stripeScheduleId, "sub_sched_1");
  assert.deepEqual(world.emails, [
    { templateKey: "plan_change_downgrade_scheduled", inTransaction: true, referenceId: "pcr_1" },
  ]);
  assert.deepEqual(world.releases, []);
});

test("two simultaneous confirms of one quote reach Stripe once and send one email", async () => {
  reset();
  await quoteDowngrade();
  const { confirmPlanChange } = await load();
  const [first, second] = await Promise.all([
    confirmPlanChange({ userId: "user_1", requestId: "pcr_1" }),
    confirmPlanChange({ userId: "user_1", requestId: "pcr_1" }),
  ]);
  assert.equal(world.scheduleCreates, 1);
  assert.equal(world.emails.length, 1);
  assert.equal(world.rows.get("pcr_1")!.status, "pending");
  assert.deepEqual(world.releases, []);
  // One reports the reservation; the other is told the quote is in flight or
  // shown the same reservation -- never a second change.
  assert.ok([first, second].some((result) => result.ok));
});

test("a schedule whose record cannot be written is released, not left to move the plan", async () => {
  reset();
  await quoteDowngrade();
  world.failEnqueue = true;
  const { confirmPlanChange } = await load();
  const result = await confirmPlanChange({ userId: "user_1", requestId: "pcr_1" });
  assert.equal(result.ok, false);
  assert.equal(world.scheduleCreates, 1);
  assert.deepEqual(world.releases, ["sub_sched_1"]);
  assert.notEqual(world.rows.get("pcr_1")!.status, "pending");
  assert.equal(world.emails.length, 0);
});

test("an upgrade's email is committed when it settles, and a redelivery sends nothing", async () => {
  reset();
  world.rows.set("pcr_up", {
    id: "pcr_up",
    userId: "user_1",
    direction: "upgrade",
    execution: "immediate_upgrade",
    fromTier: "Pro",
    toTier: "Max",
    billingInterval: "monthly",
    status: "pending",
    stripeSubscriptionId: "sub_1",
    stripeScheduleId: null,
    confirmedAt: new Date(Date.now() - 60_000),
  });
  const { settlePlanChangesForSubscription } = await load();
  const subscription = structuredClone(world.subscription);
  assert.deepEqual(await settlePlanChangesForSubscription(subscription, "invoice.paid"), { settled: "applied" });
  assert.deepEqual(await settlePlanChangesForSubscription(subscription, "invoice.paid"), { settled: null });
  assert.deepEqual(world.emails, [{ templateKey: "plan_change_upgraded", inTransaction: true, referenceId: "pcr_up" }]);
});

test("a quote claimed by a confirm that stops before Stripe is spent, not left in flight", async () => {
  reset();
  await quoteDowngrade();
  world.failRetrieve = true;
  const { confirmPlanChange } = await load();
  await assert.rejects(confirmPlanChange({ userId: "user_1", requestId: "pcr_1" }));
  assert.equal(world.rows.get("pcr_1")!.status, "failed");
  assert.equal(world.scheduleCreates, 0);
  // The retry is told the quote is spent, not that it is "already being confirmed".
  world.failRetrieve = false;
  const retry = await confirmPlanChange({ userId: "user_1", requestId: "pcr_1" });
  assert.notEqual((retry as { code?: string }).code, "PLAN_CHANGE_ALREADY_PENDING");
  assert.equal(world.scheduleCreates, 0);
});
