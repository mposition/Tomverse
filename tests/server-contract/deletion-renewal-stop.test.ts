import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// stopDeletionPendingRenewal (lib/deletionCancellation.ts): a renewal invoice of
// an account scheduled for deletion is never collected
// (docs/policy/plan-change.md section 10). Driven against fakes of the account
// row lock and of Stripe, so what is checked is which Stripe writes happen.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;

const state = {
  accountStatus: "pending_deletion",
  invoiceStatus: "draft",
  subscriptionStatus: "active",
  failCancel: false,
  cancels: [] as { id: string; params: Record<string, unknown> }[],
  locked: 0,
};

const reset = (overrides: Partial<typeof state> = {}) => {
  Object.assign(state, {
    accountStatus: "pending_deletion",
    invoiceStatus: "draft",
    subscriptionStatus: "active",
    failCancel: false,
    cancels: [],
    locked: 0,
    ...overrides,
  });
};

mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          // The account row lock: matches only while the account is pending deletion.
          $queryRaw: async () => {
            state.locked += 1;
            return state.accountStatus === "pending_deletion" ? [{ id: "user_1" }] : [];
          },
        }),
    },
  },
});
mock.module(mod("lib/stripe.ts"), {
  namedExports: {
    getStripe: () => ({
      invoices: { retrieve: async () => ({ id: "in_1", status: state.invoiceStatus }) },
      subscriptions: {
        retrieve: async () => ({ id: "sub_1", status: state.subscriptionStatus, cancel_at_period_end: false }),
        update: async () => {
          throw new Error("unexpected update");
        },
        cancel: async (id: string, params: Record<string, unknown>) => {
          if (state.failCancel) throw new Error("timeout");
          state.cancels.push({ id, params });
          state.subscriptionStatus = "canceled";
          return { id, status: "canceled" };
        },
      },
    }),
  },
});

const call = async () => {
  const { stopDeletionPendingRenewal } = await import(mod("lib/deletionCancellation.ts"));
  return stopDeletionPendingRenewal({ subscriptionId: "sub_1", invoiceId: "in_1" });
};

test("a draft renewal of an account pending deletion ends the subscription without proration or a final invoice", async () => {
  reset();
  const outcome = await call();
  assert.deepEqual(outcome, { pendingDeletion: true, cancelled: true, invoiceFinalized: false });
  assert.deepEqual(state.cancels, [{ id: "sub_1", params: { prorate: false, invoice_now: false } }]);
  assert.equal(state.locked, 1);
});

test("a restored account renews: nothing is written", async () => {
  reset({ accountStatus: "active" });
  const outcome = await call();
  assert.deepEqual(outcome, { pendingDeletion: false, cancelled: false, invoiceFinalized: false });
  assert.equal(state.cancels.length, 0);
});

test("an already paid renewal is left for a person (no cancel) and reported as finalized", async () => {
  reset({ invoiceStatus: "paid" });
  const outcome = await call();
  assert.deepEqual(outcome, { pendingDeletion: true, cancelled: false, invoiceFinalized: true });
  assert.equal(state.cancels.length, 0);
});

test("an open (finalized, unpaid) renewal still stops collection and is reported", async () => {
  reset({ invoiceStatus: "open" });
  const outcome = await call();
  assert.deepEqual(outcome, { pendingDeletion: true, cancelled: true, invoiceFinalized: true });
  assert.equal(state.cancels.length, 1);
});

test("an already ended subscription is not cancelled again", async () => {
  reset({ subscriptionStatus: "canceled" });
  const outcome = await call();
  assert.equal(outcome.cancelled, false);
  assert.equal(state.cancels.length, 0);
});

test("Stripe requests inside the lock share one budget that ends before the transaction", async () => {
  const { stripeLockBudget } = await import(mod("lib/deletionCancellation.ts"));
  let clock = 0;
  const budget = stripeLockBudget(15_000, () => clock);
  assert.deepEqual(budget(), { timeout: 8_000, maxNetworkRetries: 0 });
  clock = 8_000; // the first request used its whole allowance
  assert.deepEqual(budget(), { timeout: 7_000, maxNetworkRetries: 0 });
  clock = 15_000; // a third request never outlives the lock
  assert.throws(() => budget(), /budget/);
});

test("a Stripe failure throws so the webhook answers 500 and the draft waits for redelivery", async () => {
  reset({ failCancel: true });
  await assert.rejects(call(), /timeout/);
  assert.equal(state.cancels.length, 0);
});
