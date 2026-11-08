import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { takeAuditChainLock } from "@/lib/adminAudit";
import { runModelCatalogEnvSync } from "@/lib/modelCatalogEnvSync";
import {
  MODEL_CATALOG_ENV_SYNC_SCHEMA_VERSION,
  MODEL_CATALOG_SYNC_TABLES,
  exportDigest,
  normalizeSyncRow,
  type SyncRow,
  type SyncTables,
} from "@/lib/modelCatalogEnvSyncCore";
import { prisma } from "@/lib/prisma";

// The weekly production-to-staging/dev catalogue copy against a real database:
// references land on this environment's ids, the audit entry is written by the
// sync actor, and an operator's price revision committed while the copy waits
// for the catalogue writers' lock holds the model instead of being outrun.

const requireDedicatedTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
};
requireDedicatedTestDatabase();

const PREFIX = "envsync-test";
const AT = new Date("2026-11-01T00:00:00.000Z");
const SYNC_ENV = {
  APP_ENV: "staging",
  MODEL_CATALOG_EXPORT_SECRET: "x".repeat(40),
  MODEL_CATALOG_ENV_SYNC_APPLY: "true",
} as unknown as NodeJS.ProcessEnv;

const spec = (model: string) => MODEL_CATALOG_SYNC_TABLES.find((item) => item.model === model)!;

const exportOf = (rows: Partial<Record<string, SyncRow[]>>) => {
  const tables: SyncTables = {};
  for (const item of MODEL_CATALOG_SYNC_TABLES) {
    tables[item.model] = (rows[item.model] ?? []).map((row) => normalizeSyncRow(item, row));
  }
  return {
    schemaVersion: MODEL_CATALOG_ENV_SYNC_SCHEMA_VERSION,
    environment: "production",
    exportedAt: AT.toISOString(),
    digest: exportDigest(tables),
    tables,
  };
};

const realFetch = globalThis.fetch;
const serveExport = (payload: unknown) => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), "https://tomverse.app/api/internal/model-catalog/export");
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
};

const cleanup = async () => {
  await prisma.modelLifecycleWorkItem.deleteMany({ where: { apiModel: { startsWith: PREFIX } } });
  await prisma.providerModelCatalogEntry.deleteMany({ where: { apiModel: { startsWith: PREFIX } } });
  await prisma.modelRegistryEntry.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.modelCatalogEntry.deleteMany({ where: { modelId: { startsWith: PREFIX } } });
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ModelCatalogPriceRevision" DISABLE TRIGGER "ModelCatalogPriceRevision_append_only_trigger"`
  );
  try {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "ModelCatalogPriceRevision" WHERE "modelId" LIKE '${PREFIX}%'`
    );
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "ModelCatalogPriceRevision" ENABLE TRIGGER "ModelCatalogPriceRevision_append_only_trigger"`
    );
  }
};

before(cleanup);
after(async () => {
  globalThis.fetch = realFetch;
  await cleanup();
  await prisma.$disconnect();
});

const registryRow = (id: string, name: string): SyncRow => ({
  id,
  name,
  apiModel: id,
  provider: "openai",
  apiBaseUrl: "https://api.openai.com/v1",
  apiKeyEnvName: "OPENAI_API_KEY",
  icon: "",
  bestFor: "",
  minimumPlan: "free",
  usageClass: "standard",
  creditWeight: 1,
  publiclyListed: false,
  enabled: false,
  status: "disabled",
  catalogDeleted: false,
  supportsImage: false,
  supportsNativePdf: false,
  sortOrder: 0,
});

const entryRow = (id: string, apiModel: string): SyncRow => ({
  id,
  provider: "openai",
  apiModel,
  status: "candidate",
  lastCheckedAt: AT,
  consecutiveSeen: 1,
  consecutiveMissing: 0,
});

const workItemRow = (id: string, apiModel: string, status: string, catalogEntryId: string | null): SyncRow => ({
  id,
  provider: "openai",
  apiModel,
  action: "add",
  status,
  severity: "normal",
  catalogEntryId,
  communicationRequired: false,
  firstSeenAt: AT,
});

test("rows are copied onto this environment's ids, with one audit entry from the sync actor", async () => {
  const a = `${PREFIX}-a`;
  const b = `${PREFIX}-b`;
  await prisma.providerModelCatalogEntry.create({ data: entryRow("local-entry", a) as never });
  await prisma.modelLifecycleWorkItem.create({
    data: workItemRow("local-item", a, "discovered", "local-entry") as never,
  });

  serveExport(
    exportOf({
      ModelRegistryEntry: [registryRow(`${PREFIX}-model`, "Synced model")],
      ProviderModelCatalogEntry: [entryRow("prod-entry", a), entryRow("prod-entry-b", b)],
      ModelLifecycleWorkItem: [
        workItemRow("prod-item", a, "approved", "prod-entry"),
        workItemRow("prod-item-b", b, "discovered", "prod-entry-b"),
      ],
      // Past-dated, as every production revision is by the time it is copied:
      // its own createdAt travels with it, so the not-retroactive check holds.
      ModelCatalogPriceRevision: [
        {
          id: `${PREFIX}-rev-1`,
          category: "image",
          modelId: `${PREFIX}-priced`,
          pricingVersion: "v1",
          prices: { usd: 1 },
          verification: {},
          effectiveFrom: AT,
          createdAt: AT,
        },
      ],
      ModelLifecycleWorkItemEvent: [
        { id: `${PREFIX}-ev-1`, workItemId: "prod-item", occurredAt: AT, toStatus: "approved" },
        { id: `${PREFIX}-ev-2`, workItemId: "prod-item-b", occurredAt: AT, toStatus: "discovered" },
      ],
    })
  );

  const result = await runModelCatalogEnvSync(SYNC_ENV);
  assert.equal(result.status, "applied");

  const itemA = await prisma.modelLifecycleWorkItem.findUnique({ where: { id: "local-item" } });
  assert.equal(itemA?.status, "approved");
  assert.equal(itemA?.catalogEntryId, "local-entry");
  const itemB = await prisma.modelLifecycleWorkItem.findUnique({ where: { id: "prod-item-b" } });
  assert.equal(itemB?.catalogEntryId, "prod-entry-b");
  const ev1 = await prisma.modelLifecycleWorkItemEvent.findUnique({ where: { id: `${PREFIX}-ev-1` } });
  assert.equal(ev1?.workItemId, "local-item");
  assert.equal(
    (await prisma.modelCatalogPriceRevision.findUnique({ where: { id: `${PREFIX}-rev-1` } }))?.createdAt.toISOString(),
    AT.toISOString()
  );
  assert.equal(
    (await prisma.modelRegistryEntry.findUnique({ where: { id: `${PREFIX}-model` } }))?.name,
    "Synced model"
  );

  assert.ok(result.status === "applied" && result.auditLogId);
  const audit = await prisma.adminAuditLog.findUnique({ where: { id: result.auditLogId } });
  assert.equal(audit?.action, "model_catalog.env_synced");
  assert.equal(audit?.targetType, "ModelCatalogEnvSync");
  assert.equal((audit?.metadata as { systemActor?: string } | null)?.systemActor, "model-catalog-env-sync");

  // A second run with the same export changes nothing and writes no entry.
  const again = await runModelCatalogEnvSync(SYNC_ENV);
  assert.equal(again.status, "applied");
  assert.ok(again.status === "applied");
  assert.equal(again.plan.totals.create + again.plan.totals.update, 0);
  assert.equal(again.auditLogId, null);
});

test("a price revision an operator commits while the copy waits holds the model", async () => {
  const modelId = `${PREFIX}-img`;
  await prisma.modelCatalogEntry.create({
    data: { category: "image", modelId, enabled: false, profile: { endpoint: "local-model" } },
  });
  serveExport(
    exportOf({
      ModelCatalogEntry: [
        { category: "image", modelId, enabled: false, profile: { endpoint: "production-model" } },
      ],
    })
  );

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const holding = new Promise<void>((resolve) => (locked = resolve));
  // The operator's revision, inside the lock every catalogue writer takes first.
  const operator = prisma.$transaction(
    async (tx) => {
      await takeAuditChainLock(tx);
      await tx.modelCatalogPriceRevision.create({
        data: {
          category: "image",
          modelId,
          pricingVersion: `${PREFIX}-local-v1`,
          prices: { usd: 1 },
          verification: {},
          effectiveFrom: new Date(Date.now() + 60_000),
        },
      });
      locked();
      await gate;
    },
    { timeout: 60_000 }
  );
  await holding;

  const sync = runModelCatalogEnvSync(SYNC_ENV);
  // Wait until the copy is actually waiting for the lock, then let the
  // operator commit: the copy must plan after that commit, not before.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [{ waiting }] = await prisma.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*)::bigint AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
    if (waiting > 0n) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  release();
  await operator;
  const result = await sync;

  assert.equal(result.status, "applied");
  assert.ok(result.status === "applied");
  assert.ok(result.plan.heldModels.includes(`image:${modelId}`));
  const entry = await prisma.modelCatalogEntry.findUnique({
    where: { category_modelId: { category: "image", modelId } },
  });
  assert.deepEqual(entry?.profile, { endpoint: "local-model" });
  assert.equal(spec("ModelCatalogEntry").model, "ModelCatalogEntry");
});
