import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * The promotion burst alert claims a band once (`ChatRequestLease` key) and
 * gives the claim back when the send fails, so a band is neither reported
 * twice nor silenced by one failed delivery.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";

type World = {
  inWindow: number;
  leases: Set<string>;
  sends: number;
  sendStatus: "sent" | "failed" | "skipped";
};

let world: World;
const freshWorld = (): World => ({
  inWindow: 0,
  leases: new Set(),
  sends: 0,
  sendStatus: "sent",
});

let installed = false;
async function load() {
  if (!installed) {
    installed = true;
    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: {
          billingPromotionRedemption: {
            count: async ({ where }: { where: { riskFlags?: unknown } }) =>
              where.riskFlags ? 4 : world.inWindow,
          },
          billingPromotion: {
            findUnique: async () => ({
              code: "OZBFREE",
              redeemedCount: 52,
              maxRedemptions: 1000,
            }),
          },
          chatRequestLease: {
            deleteMany: async ({ where }: { where: { id: string; expiresAt?: unknown } }) => {
              // Expired-claim cleanup carries expiresAt; a give-back does not.
              if (!where.expiresAt) world.leases.delete(where.id);
              return { count: 0 };
            },
            create: async ({ data }: { data: { id: string } }) => {
              if (world.leases.has(data.id)) {
                throw Object.assign(new Error("unique"), { code: "P2002" });
              }
              world.leases.add(data.id);
              return data;
            },
          },
        },
      },
    });
    mock.module(mod("lib/managedSlack.ts"), {
      namedExports: {
        sendManagedSlackMessage: async () => {
          world.sends += 1;
          return {
            delivered: world.sendStatus === "sent",
            status: world.sendStatus,
            title: "t",
          };
        },
      },
    });
  }
  return (await import(mod("lib/promotionBurstAlert.ts"))) as typeof import(
    "../../lib/promotionBurstAlert"
  );
}

const NOW = new Date("2026-11-20T09:10:00.000Z");

test.beforeEach(() => {
  world = freshWorld();
});

test("below the threshold nothing is claimed or sent", async () => {
  const { alertOnPromotionBurst } = await load();
  world.inWindow = 9;
  await alertOnPromotionBurst("promo_1", NOW);
  assert.equal(world.sends, 0);
  assert.equal(world.leases.size, 0);
});

test("a band is reported once, however many redemptions land in it", async () => {
  const { alertOnPromotionBurst } = await load();
  for (const count of [11, 11, 12, 19]) {
    world.inWindow = count;
    await alertOnPromotionBurst("promo_1", NOW);
  }
  assert.equal(world.sends, 1);
  world.inWindow = 20;
  await alertOnPromotionBurst("promo_1", NOW);
  assert.equal(world.sends, 2);
});

test("a failed send gives the band back, so the next redemption reports it", async () => {
  const { alertOnPromotionBurst } = await load();
  world.inWindow = 10;
  world.sendStatus = "failed";
  await assert.rejects(alertOnPromotionBurst("promo_1", NOW));
  assert.equal(world.leases.size, 0);

  world.sendStatus = "sent";
  world.inWindow = 11;
  const result = await alertOnPromotionBurst("promo_1", NOW);
  assert.equal(result.alerted, true);
  assert.equal(world.sends, 2);
});

test("a skipped send (template off, no webhook) keeps the claim", async () => {
  const { alertOnPromotionBurst } = await load();
  world.inWindow = 10;
  world.sendStatus = "skipped";
  const result = await alertOnPromotionBurst("promo_1", NOW);
  assert.equal(result.alerted, false);
  await alertOnPromotionBurst("promo_1", NOW);
  assert.equal(world.sends, 1);
});
