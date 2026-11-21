import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * The real Prisma predicates behind binding a promotion checkout lease to its
 * Checkout Session and releasing it (lib/billingPromotionSecurity.ts). The
 * webhook and checkout contract tests mock these functions; this file checks
 * what they actually ask the database to match.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.NEXTAUTH_SECRET ||= "lease-ownership-secret";

const calls: { op: string; args: { where: Record<string, unknown>; data?: unknown } }[] = [];

let installed = false;
async function load() {
  if (!installed) {
    installed = true;
    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: {
          chatRequestLease: {
            updateMany: async (args: { where: Record<string, unknown>; data: unknown }) => {
              calls.push({ op: "updateMany", args });
              return { count: 1 };
            },
            deleteMany: async (args: { where: Record<string, unknown> }) => {
              calls.push({ op: "deleteMany", args });
              return { count: 1 };
            },
          },
        },
      },
    });
  }
  return (await import(mod("lib/billingPromotionSecurity.ts"))) as typeof import(
    "../../lib/billingPromotionSecurity"
  );
}

test.beforeEach(() => {
  calls.length = 0;
});

test("binding stamps only an unbound lease with its Session", async () => {
  const { bindPromotionCheckoutLease } = await load();
  await bindPromotionCheckoutLease("promo_1", "user_1", "cs_1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, "updateMany");
  assert.equal(calls[0].args.where.admissionId, null);
  assert.match(String(calls[0].args.where.id), /^promo-[a-f0-9]{64}$/);
  assert.deepEqual(calls[0].args.data, { admissionId: "stripe-session:cs_1" });
});

test("a Session's release matches its own bound lease, or an unbound one taken before it", async () => {
  const { releasePromotionCheckout } = await load();
  const createdAt = new Date("2027-01-15T08:00:00.000Z");
  await releasePromotionCheckout("promo_1", "user_1", {
    checkoutSessionId: "cs_1",
    takenAtOrBefore: createdAt,
  });
  assert.deepEqual(calls[0].args.where.OR, [
    { admissionId: "stripe-session:cs_1" },
    { admissionId: null, createdAt: { lte: createdAt } },
  ]);
});

test("without a time bound a Session's release never touches an unbound lease", async () => {
  // It could be a newer attempt's lease whose bind failed.
  const { releasePromotionCheckout } = await load();
  await releasePromotionCheckout("promo_1", "user_1", { checkoutSessionId: "cs_1" });
  assert.deepEqual(calls[0].args.where.OR, [{ admissionId: "stripe-session:cs_1" }]);
});

test("a release that names no Session keeps the old behaviour", async () => {
  // The checkout route releasing its own in-flight attempt.
  const { releasePromotionCheckout } = await load();
  await releasePromotionCheckout("promo_1", "user_1");
  assert.equal("OR" in calls[0].args.where, false);
  assert.equal("createdAt" in calls[0].args.where, false);
});
