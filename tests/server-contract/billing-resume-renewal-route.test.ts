import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";
import { createRequire } from "node:module";

// DELETE /api/billing/cancel-subscription -- undo a scheduled cancellation
// (docs/policy/plan-change.md section 10). Driven against fakes of the account
// store and of Stripe, so what is checked is which Stripe writes happen.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;

type Subscription = { id: string; status: string; cancel_at_period_end: boolean };

const state: {
  session: { user: { id: string } } | null;
  account: { id: string; accountStatus: string; stripeSubscriptionId: string | null; subscriptionCurrentPeriodEnd: Date | null } | null;
  subscription: Subscription;
  /** Applied to the account right after the resume write reaches Stripe: a deletion landing mid-request. */
  deletionDuringWrite: boolean;
  failResume: boolean;
  failRestore: boolean;
  writes: boolean[];
  accountUpdates: Record<string, unknown>[];
  incidents: string[];
} = {
  session: null,
  account: null,
  subscription: { id: "sub_1", status: "active", cancel_at_period_end: true },
  deletionDuringWrite: false,
  failResume: false,
  failRestore: false,
  writes: [],
  accountUpdates: [],
  incidents: [],
};

const reset = (overrides: Partial<typeof state> = {}) => {
  Object.assign(state, {
    session: { user: { id: "user_1" } },
    account: { id: "user_1", accountStatus: "active", stripeSubscriptionId: "sub_1", subscriptionCurrentPeriodEnd: null },
    subscription: { id: "sub_1", status: "active", cancel_at_period_end: true },
    deletionDuringWrite: false,
    failResume: false,
    failRestore: false,
    writes: [],
    accountUpdates: [],
    incidents: [],
    ...overrides,
  });
};

// Resolved, not spelled out: the package may live in a parent node_modules.
mock.module(pathToFileURL(createRequire(import.meta.url).resolve("next-auth/next")).href, {
  namedExports: { getServerSession: async () => state.session },
});
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/apiSecurity.ts"), {
  namedExports: {
    consumeApiRateLimit: async () => {},
    apiSecurityResponse: () => null,
    readLimitedJson: async () => ({}),
  },
});
mock.module(mod("lib/productAnalyticsServer.ts"), {
  namedExports: { analyticsCountryFromHeaders: () => "ZZ", recordProductAnalyticsEvent: async () => {} },
});
mock.module(mod("lib/operationalMonitoring.ts"), {
  namedExports: {
    reportOperationalIncident: async ({ code }: { code: string }) => {
      state.incidents.push(code);
    },
  },
});
mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      user: {
        findUnique: async () => (state.account ? { ...state.account } : null),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          state.accountUpdates.push(data);
          return {};
        },
      },
    },
  },
});
mock.module(mod("lib/stripe.ts"), {
  namedExports: {
    isStripeConfigured: () => true,
    getStripe: () => ({
      subscriptions: {
        retrieve: async () => ({ ...state.subscription }),
        update: async (_id: string, params: { cancel_at_period_end: boolean }) => {
          const resume = params.cancel_at_period_end === false;
          if (resume && state.failResume) {
            // A write whose answer never arrives: it may still have applied.
            state.writes.push(false);
            state.subscription.cancel_at_period_end = false;
            if (state.deletionDuringWrite && state.account) state.account.accountStatus = "pending_deletion";
            throw new Error("timeout");
          }
          if (!resume && state.failRestore) throw new Error("stripe down");
          state.writes.push(params.cancel_at_period_end);
          state.subscription.cancel_at_period_end = params.cancel_at_period_end;
          if (resume && state.deletionDuringWrite && state.account) {
            state.account.accountStatus = "pending_deletion";
          }
          return { ...state.subscription };
        },
      },
    }),
  },
});

const loadRoute = async (): Promise<{ DELETE: (request: Request) => Promise<Response> }> =>
  import(mod("app/api/billing/cancel-subscription/route.ts"));
const call = async () => {
  const { DELETE } = await loadRoute();
  const response = await DELETE(new Request("https://tomverse.app/api/billing/cancel-subscription", { method: "DELETE" }));
  return { status: response.status, body: (await response.json()) as { code?: string; cancelAtPeriodEnd?: boolean } };
};

test("a cancelled subscription renews again, written to Stripe once", async () => {
  reset();
  const { status, body } = await call();
  assert.equal(status, 200);
  assert.equal(body.cancelAtPeriodEnd, false);
  assert.deepEqual(state.writes, [false]);
  assert.equal(state.accountUpdates.at(-1)?.subscriptionCancelAtPeriodEnd, false);
});

test("an account scheduled for deletion is refused before anything is written", async () => {
  reset();
  state.account!.accountStatus = "pending_deletion";
  const { status, body } = await call();
  assert.equal(status, 409);
  assert.equal(body.code, "ACCOUNT_DELETION_PENDING");
  assert.deepEqual(state.writes, []);
});

test("only active and trialing subscriptions renew from here, checked before 'already renewing'", async () => {
  for (const status of ["past_due", "canceled", "unpaid"]) {
    reset({ subscription: { id: "sub_1", status, cancel_at_period_end: false } });
    const result = await call();
    assert.equal(result.status, 409, status);
    assert.equal(result.body.code, "SUBSCRIPTION_NOT_CHANGEABLE", status);
    assert.deepEqual(state.writes, [], status);
  }
});

test("an already-renewing subscription answers success and corrects a stale stored flag", async () => {
  reset({ subscription: { id: "sub_1", status: "active", cancel_at_period_end: false } });
  const { status, body } = await call();
  assert.equal(status, 200);
  assert.equal(body.cancelAtPeriodEnd, false);
  assert.deepEqual(state.writes, []);
  assert.equal(state.accountUpdates.at(-1)?.subscriptionCancelAtPeriodEnd, false);
});

test("a deletion that lands during the write gets its cancellation back", async () => {
  reset({ deletionDuringWrite: true });
  const { status, body } = await call();
  assert.equal(status, 409);
  assert.equal(body.code, "ACCOUNT_DELETION_PENDING");
  assert.deepEqual(state.writes, [false, true]);
  assert.equal(state.subscription.cancel_at_period_end, true);
  assert.equal(state.accountUpdates.at(-1)?.subscriptionCancelAtPeriodEnd, true);
});

test("a resume that times out is still reconciled against a deletion", async () => {
  reset({ deletionDuringWrite: true, failResume: true });
  const { status } = await call();
  assert.equal(status, 500);
  assert.equal(state.subscription.cancel_at_period_end, true);
  assert.deepEqual(state.incidents, []);
});

test("a cancellation that cannot be restored is an operational incident", async () => {
  reset({ deletionDuringWrite: true, failRestore: true });
  const { status } = await call();
  assert.equal(status, 500);
  assert.deepEqual(state.incidents, ["BILLING_RESUME_RENEWAL_DELETION_CONFLICT"]);
});
