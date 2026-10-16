import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { syncBillingDefaultsToDatabase } from "@/lib/billingConfig";
import { BILLING_PRICE_CATALOG_KEY, DEFAULT_BILLING_PRICE_CATALOG } from "@/lib/billingPriceCatalog";
import { holdMarketingFactRows } from "@/lib/marketingFactResolution";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { prisma } from "@/lib/prisma";

// S3a2 review (codex, major): at READ COMMITTED each statement has its own
// snapshot, so facts read one after another could be a combination that never
// existed. The resolver locks the rows a price or model fact rests on before
// reading them; this shows a writer on another connection cannot change them
// until the reading transaction ends, and can afterwards.

let modelId = "";

before(async () => {
  await syncBillingDefaultsToDatabase();
  await prisma.appSetting.upsert({
    where: { key: BILLING_PRICE_CATALOG_KEY },
    create: { key: BILLING_PRICE_CATALOG_KEY, value: JSON.stringify(DEFAULT_BILLING_PRICE_CATALOG) },
    update: {},
  });
  const models = await getRuntimeModels({ includeCatalogDeleted: true });
  modelId = models[0]?.id ?? "";
  assert.ok(modelId, "the registry has a model row to hold");
});
after(() => prisma.$disconnect());

/** A write on another connection that gives up after a short wait for a lock. */
const writeElsewhere = (statement: (tx: typeof prisma) => Promise<unknown>) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '300ms'`;
    await statement(tx as unknown as typeof prisma);
  });

const writes: Array<[string, (tx: typeof prisma) => Promise<unknown>]> = [
  ["a plan row", (tx) => tx.$executeRaw`UPDATE "BillingPlan" SET "sortOrder" = "sortOrder" WHERE "id" = 'pro'`],
  [
    "the catalogue row",
    (tx) => tx.$executeRaw`UPDATE "AppSetting" SET "value" = "value" WHERE "key" = ${BILLING_PRICE_CATALOG_KEY}`,
  ],
  ["a model row", (tx) => tx.$executeRaw`UPDATE "ModelRegistryEntry" SET "sortOrder" = "sortOrder" WHERE "id" = ${modelId}`],
];

for (const [name, write] of writes) {
  test(`${name} a fact rests on cannot change while the reading transaction is open`, async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held!: () => void;
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });

    const reader = prisma.$transaction(
      async (tx) => {
        await holdMarketingFactRows(tx, { plans: true, catalogue: true, modelIds: [modelId] });
        held();
        await released;
      },
      { timeout: 20_000 },
    );

    await holding;
    await assert.rejects(writeElsewhere(write), /lock|55P03/i);
    release();
    await reader;
    // Once the reader has committed, the same write goes through.
    await writeElsewhere(write);
  });
}

test("a hold names only what was asked for", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held!: () => void;
  const holding = new Promise<void>((resolve) => {
    held = resolve;
  });
  const reader = prisma.$transaction(
    async (tx) => {
      await holdMarketingFactRows(tx, { plans: false, catalogue: false, modelIds: [modelId] });
      held();
      await released;
    },
    { timeout: 20_000 },
  );
  await holding;
  // Plans were not held, so their writer does not wait.
  await writeElsewhere(writes[0][1]);
  release();
  await reader;
});

test("a hold reports the rows it took, and a row that was not there is not among them", async () => {
  const held = await prisma.$transaction((tx) =>
    holdMarketingFactRows(tx, { plans: true, catalogue: true, modelIds: [modelId, "model-that-is-not-there"] }),
  );
  assert.deepEqual([...held.modelIds], [modelId]);
  assert.equal(held.catalogue, true);
  assert.ok(held.planIds.has("pro"));
});
