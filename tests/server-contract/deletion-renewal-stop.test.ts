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
  /** Invoices reported as already paid when re-read (paid after the list). */
  paidAfterList: [] as string[],
  manualDrafts: 100,
  noOpen: false,
  secondDraft: false,
  listParams: [] as { status?: string; created?: { gte: number } }[],
  oldDunning: false,
  paidJustNow: false,
  subscriptionStatus: "active",
  failCancel: false,
  cancels: [] as { id: string; params: Record<string, unknown> }[],
  locked: 0,
};

const reset = (overrides: Partial<typeof state> = {}) => {
  Object.assign(state, {
    accountStatus: "pending_deletion",
    invoiceStatus: "draft",
    paidAfterList: [],
    manualDrafts: 100,
    noOpen: false,
    secondDraft: false,
    listParams: [],
    oldDunning: false,
    paidJustNow: false,
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
      invoices: {
        retrieve: async (id: string) => ({
          id,
          status: state.paidAfterList.includes(id)
            ? "paid"
            : id === "in_open" || id === "in_dunning"
              ? "open"
              : state.invoiceStatus,
        }),
        // Auto-paginating list: the renewal sits behind a full page of manual drafts.
        // One listing of every status: the caller filters, so a renewal that
        // moves from draft to open during the listing is still in it.
        list: (params: { status?: string; created?: { gte: number } }) =>
          (async function* () {
            state.listParams.push(params);
            // An old renewal still in dunning: a listing with a date floor would miss it.
            if (state.oldDunning) yield { id: "in_dunning", status: "open", billing_reason: "subscription_cycle" };
            yield { id: "in_paid_old", status: "paid", billing_reason: "subscription_cycle" };
            if (state.paidJustNow) {
              yield {
                id: "in_paid_now",
                status: "paid",
                billing_reason: "subscription_cycle",
                status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
              };
            }
            if (!state.noOpen) yield { id: "in_open", status: "open", billing_reason: "subscription_cycle" };
            for (let i = 0; i < state.manualDrafts; i += 1) yield { id: `in_m${i}`, status: "draft", billing_reason: "manual" };
            yield { id: "in_1", status: "draft", billing_reason: "subscription_cycle" };
            if (state.secondDraft) yield { id: "in_2", status: "draft", billing_reason: "subscription_cycle" };
          })(),
      },
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

test("the deletion flow stops a renewal drafted before pending_deletion was committed", async () => {
  reset();
  const { stopDeletionPendingDraftRenewals } = await import(mod("lib/deletionCancellation.ts"));
  // Both renewals are found before anything is cancelled (the cancellation's
  // webhook clears the account's subscription id); one cancellation stops
  // collection on all of them, and the open one is counted for a person.
  assert.deepEqual(await stopDeletionPendingDraftRenewals("sub_1", new Date(0)), { stopped: 1, finalized: 1 });
  // Only renewals are looked at; other invoices are not reasons to cancel.
  assert.equal(state.cancels.length, 1);
  assert.equal(state.locked, 1);
});

test("a renewal paid after the lookup does not stop the check of the others", async () => {
  reset({ paidAfterList: ["in_open"] });
  const { stopDeletionPendingDraftRenewals } = await import(mod("lib/deletionCancellation.ts"));
  assert.deepEqual(await stopDeletionPendingDraftRenewals("sub_1", new Date(0)), { stopped: 1, finalized: 1 });
  assert.equal(state.cancels.length, 1);
});

test("a lookup cut off by the scan limit is a failure, after stopping what it found", async () => {
  reset({ manualDrafts: 600 });
  const { stopDeletionPendingDraftRenewals } = await import(mod("lib/deletionCancellation.ts"));
  await assert.rejects(stopDeletionPendingDraftRenewals("sub_1", new Date(0)), /scan limit/);
  assert.equal(state.cancels.length, 1);
});

test("a void or uncollectible renewal is no reason to end the subscription", async () => {
  for (const invoiceStatus of ["void", "uncollectible"]) {
    reset({ invoiceStatus });
    const outcome = await call();
    assert.equal(outcome.cancelled, false, invoiceStatus);
    assert.equal(state.cancels.length, 0, invoiceStatus);
  }
});

test("a draft renewal paid before its re-read is counted for a person", async () => {
  reset({ paidAfterList: ["in_open", "in_1"] });
  const { stopDeletionPendingDraftRenewals } = await import(mod("lib/deletionCancellation.ts"));
  assert.deepEqual(await stopDeletionPendingDraftRenewals("sub_1", new Date(0)), { stopped: 0, finalized: 2 });
  assert.equal(state.cancels.length, 0);
});

test("after the cancellation the remaining renewals are re-read, and one paid meanwhile is counted", async () => {
  reset({ noOpen: true, secondDraft: true, paidAfterList: ["in_2"] });
  const { stopDeletionPendingDraftRenewals } = await import(mod("lib/deletionCancellation.ts"));
  assert.deepEqual(await stopDeletionPendingDraftRenewals("sub_1", new Date(0)), { stopped: 1, finalized: 1 });
  assert.equal(state.cancels.length, 1);
});

test("the renewal lookup is one listing of every invoice, with no status or date filter", async () => {
  reset();
  const { stopDeletionPendingDraftRenewals } = await import(mod("lib/deletionCancellation.ts"));
  await stopDeletionPendingDraftRenewals("sub_1", new Date(0));
  assert.equal(state.listParams.length, 1);
  assert.equal(state.listParams[0]!.status, undefined);
  assert.equal(state.listParams[0]!.created, undefined);
});

test("an old renewal still in dunning is found and counted, not only recent ones", async () => {
  reset({ oldDunning: true, paidAfterList: ["in_open", "in_1"] });
  const { stopDeletionPendingDraftRenewals } = await import(mod("lib/deletionCancellation.ts"));
  const result = await stopDeletionPendingDraftRenewals("sub_1", new Date(0));
  // The dunning renewal is the one still collectible: it ends the subscription.
  assert.equal(result.stopped, 1);
  assert.equal(result.finalized, 3);
  assert.equal(state.cancels.length, 1);
});

test("a renewal paid in the same second the deletion started is counted", async () => {
  reset({ paidJustNow: true, noOpen: true });
  const { stopDeletionPendingDraftRenewals } = await import(mod("lib/deletionCancellation.ts"));
  // Started later within the same second as paid_at (whole seconds at Stripe).
  const sameSecond = new Date(Math.floor(Date.now() / 1000) * 1000 + 999);
  assert.equal((await stopDeletionPendingDraftRenewals("sub_1", sameSecond)).finalized, 1);
});

test("a renewal paid after the deletion started is counted for a person; one paid before is not", async () => {
  reset({ paidJustNow: true, noOpen: true });
  const { stopDeletionPendingDraftRenewals } = await import(mod("lib/deletionCancellation.ts"));
  const startedAt = new Date(Date.now() - 60_000);
  assert.deepEqual(await stopDeletionPendingDraftRenewals("sub_1", startedAt), { stopped: 1, finalized: 1 });
  reset({ paidJustNow: true, noOpen: true });
  const later = new Date(Date.now() + 60_000);
  assert.deepEqual(await stopDeletionPendingDraftRenewals("sub_1", later), { stopped: 1, finalized: 0 });
});
