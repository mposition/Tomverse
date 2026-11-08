import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MODEL_CATALOG_SYNC_TABLES,
  exportDigest,
  isModelCatalogEnvSyncDay,
  normalizeSyncRow,
  planModelCatalogEnvSync,
  validateModelCatalogExport,
} from "../lib/modelCatalogEnvSyncCore.ts";

const SCALAR = new Set(["String", "Int", "Float", "Boolean", "DateTime", "Json", "BigInt", "Decimal"]);

/** Scalar column names of one model block in prisma/schema.prisma. */
const schemaScalars = (model) => {
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const match = schema.match(new RegExp(`\\nmodel ${model} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `model ${model} not found in schema.prisma`);
  const names = [];
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.trim().match(/^(\w+)\s+(\w+)(\?|\[\])?/);
    if (field && SCALAR.has(field[2])) names.push(field[1]);
  }
  return names.sort();
};

const spec = (model) => MODEL_CATALOG_SYNC_TABLES.find((item) => item.model === model);

const emptyTables = () =>
  Object.fromEntries(MODEL_CATALOG_SYNC_TABLES.map((item) => [item.model, []]));

const tablePlan = (plan, model) => plan.tables.find((item) => item.model === model);

test("every scalar column of every synced model is either copied or excluded", () => {
  for (const item of MODEL_CATALOG_SYNC_TABLES) {
    const placed = [...new Set([...(item.createId ? ["id"] : []), ...item.fields, ...item.excluded])].sort();
    assert.deepEqual(placed, schemaScalars(item.model), item.model);
    for (const name of [...item.dateFields, ...item.jsonFields, ...item.key]) {
      assert.ok(item.fields.includes(name), `${item.model}.${name} is not a copied field`);
    }
  }
});

test("user ids never travel between environments", () => {
  for (const item of MODEL_CATALOG_SYNC_TABLES) {
    for (const name of ["updatedById", "actorId", "reviewerId", "publishedById"]) {
      assert.equal(item.fields.includes(name), false, `${item.model}.${name}`);
    }
  }
  const row = normalizeSyncRow(spec("ModelRegistryEntry"), {
    id: "gpt-x",
    name: "GPT X",
    updatedById: "user_1",
    updatedByEmail: "owner@example.com",
  });
  assert.equal("updatedById" in row, false);
  assert.equal(row.updatedByEmail, "owner@example.com");
  assert.equal(row.icon, null);
});

test("the registry, the image/coding catalogue and the discovery tables travel together", () => {
  assert.deepEqual(
    MODEL_CATALOG_SYNC_TABLES.map((item) => item.model),
    [
      "ModelRegistryEntry",
      "ModelOverride",
      "ModelCatalogEntry",
      "ModelCatalogPriceRevision",
      "ProviderModelCatalogEntry",
      "ProviderModelDocEvidence",
      "ModelLifecycleWorkItem",
      "ModelLifecycleWorkItemEvent",
    ]
  );
});

test("plan creates missing rows, updates changed ones and keeps local-only rows", () => {
  const registry = spec("ModelRegistryEntry");
  const base = normalizeSyncRow(registry, { id: "a", name: "A", creditWeight: 1, enabled: true });
  const source = emptyTables();
  const local = emptyTables();
  source.ModelRegistryEntry = [
    base,
    { ...normalizeSyncRow(registry, { id: "b", name: "B", creditWeight: 2 }) },
    { ...normalizeSyncRow(registry, { id: "c", name: "C", creditWeight: 3 }) },
  ];
  local.ModelRegistryEntry = [
    base,
    normalizeSyncRow(registry, { id: "b", name: "B", creditWeight: 9 }),
    normalizeSyncRow(registry, { id: "local-only", name: "L" }),
  ];
  const plan = planModelCatalogEnvSync(source, local);
  const table = tablePlan(plan, "ModelRegistryEntry");
  assert.equal(table.unchanged, 1);
  assert.deepEqual(table.create.map((row) => row.id), ["c"]);
  assert.equal(table.update.length, 1);
  assert.deepEqual(table.update[0].where, { id: "b" });
  assert.equal(table.update[0].data.creditWeight, 2);
  assert.equal("id" in table.update[0].data, false);
  assert.equal(table.localOnly, 1);
  assert.deepEqual(plan.totals, { create: 1, update: 1, unchanged: 1, conflicts: 0, localOnly: 1 });
});

test("a column production does not export yet is kept, and one this environment lacks is dropped", () => {
  const source = emptyTables();
  const local = emptyTables();
  const registry = spec("ModelRegistryEntry");
  // Production's code is older: its row has no maxImages at all.
  const prodRow = normalizeSyncRow(registry, { id: "a", name: "A v2", maxImages: 4 });
  delete prodRow.maxImages;
  prodRow.columnOnlyProductionHas = "x";
  source.ModelRegistryEntry = [prodRow, { id: "new", name: "New", columnOnlyProductionHas: "y" }];
  local.ModelRegistryEntry = [normalizeSyncRow(registry, { id: "a", name: "A", maxImages: 4 })];
  const table = tablePlan(planModelCatalogEnvSync(source, local), "ModelRegistryEntry");
  assert.equal(table.update.length, 1);
  assert.equal(table.update[0].data.name, "A v2");
  assert.equal("maxImages" in table.update[0].data, false);
  assert.equal("columnOnlyProductionHas" in table.update[0].data, false);
  assert.deepEqual(table.create, [{ id: "new", name: "New" }]);
});

test("JSON fields compare by content, not key order", () => {
  const item = spec("ModelCatalogEntry");
  const source = emptyTables();
  const local = emptyTables();
  source.ModelCatalogEntry = [
    normalizeSyncRow(item, { category: "image", modelId: "m", profile: { a: 1, b: { c: 2, d: 3 } } }),
  ];
  local.ModelCatalogEntry = [
    normalizeSyncRow(item, { category: "image", modelId: "m", profile: { b: { d: 3, c: 2 }, a: 1 } }),
  ];
  assert.equal(tablePlan(planModelCatalogEnvSync(source, local), "ModelCatalogEntry").unchanged, 1);
});

test("an append-only row is inserted when missing and never rewritten", () => {
  const item = spec("ModelCatalogPriceRevision");
  const revision = (id, prices) =>
    normalizeSyncRow(item, {
      id,
      category: "image",
      modelId: "m",
      pricingVersion: "v1",
      prices,
      verification: {},
      effectiveFrom: new Date("2026-11-01T00:00:00.000Z"),
      createdAt: new Date("2026-11-01T00:00:00.000Z"),
    });
  const source = emptyTables();
  const local = emptyTables();
  source.ModelCatalogPriceRevision = [revision("prod-1", { usd: 1 })];
  local.ModelCatalogPriceRevision = [revision("local-1", { usd: 2 })];
  const conflicting = tablePlan(planModelCatalogEnvSync(source, local), "ModelCatalogPriceRevision");
  assert.equal(conflicting.conflicts, 1);
  assert.equal(conflicting.update.length, 0);
  assert.equal(conflicting.create.length, 0);

  local.ModelCatalogPriceRevision = [];
  const missing = tablePlan(planModelCatalogEnvSync(source, local), "ModelCatalogPriceRevision");
  assert.equal(missing.create.length, 1);
  assert.equal(missing.create[0].id, "prod-1");
  assert.equal(missing.create[0].effectiveFrom, "2026-11-01T00:00:00.000Z");
});

test("work items and their events point at this environment's ids", () => {
  const entry = spec("ProviderModelCatalogEntry");
  const item = spec("ModelLifecycleWorkItem");
  const event = spec("ModelLifecycleWorkItemEvent");
  const at = new Date("2026-11-01T00:00:00.000Z");
  const source = emptyTables();
  const local = emptyTables();

  source.ProviderModelCatalogEntry = [
    normalizeSyncRow(entry, { id: "prod-entry", provider: "openai", apiModel: "gpt-x", lastCheckedAt: at }),
  ];
  local.ProviderModelCatalogEntry = [
    normalizeSyncRow(entry, { id: "local-entry", provider: "openai", apiModel: "gpt-x", lastCheckedAt: at }),
  ];
  source.ModelLifecycleWorkItem = [
    normalizeSyncRow(item, {
      id: "prod-item",
      provider: "openai",
      apiModel: "gpt-x",
      action: "add",
      status: "adopted",
      catalogEntryId: "prod-entry",
    }),
    normalizeSyncRow(item, {
      id: "prod-new-item",
      provider: "openai",
      apiModel: "gpt-y",
      action: "add",
      status: "discovered",
    }),
  ];
  local.ModelLifecycleWorkItem = [
    normalizeSyncRow(item, {
      id: "local-item",
      provider: "openai",
      apiModel: "gpt-x",
      action: "add",
      status: "discovered",
      catalogEntryId: "local-entry",
    }),
  ];
  source.ModelLifecycleWorkItemEvent = [
    normalizeSyncRow(event, { id: "ev-1", workItemId: "prod-item", occurredAt: at, toStatus: "adopted" }),
    normalizeSyncRow(event, { id: "ev-2", workItemId: "prod-new-item", occurredAt: at, toStatus: "discovered" }),
  ];

  const plan = planModelCatalogEnvSync(source, local);
  const items = tablePlan(plan, "ModelLifecycleWorkItem");
  assert.equal(items.update.length, 1);
  assert.deepEqual(items.update[0].where, { provider: "openai", apiModel: "gpt-x", action: "add" });
  assert.equal(items.update[0].data.status, "adopted");
  assert.equal(items.update[0].data.catalogEntryId, "local-entry");
  assert.deepEqual(items.create.map((row) => row.id), ["prod-new-item"]);

  const events = tablePlan(plan, "ModelLifecycleWorkItemEvent");
  assert.deepEqual(
    events.create.map((row) => [row.id, row.workItemId]),
    [
      ["ev-1", "local-item"],
      ["ev-2", "prod-new-item"],
    ]
  );
});

const validExport = () => {
  const tables = emptyTables();
  tables.ModelRegistryEntry = [normalizeSyncRow(spec("ModelRegistryEntry"), { id: "a", name: "A" })];
  return {
    schemaVersion: 1,
    environment: "production",
    exportedAt: "2026-11-08T00:00:00.000Z",
    digest: exportDigest(tables),
    tables,
  };
};

test("an export is accepted only when it is production's, complete and undamaged", () => {
  assert.equal(validateModelCatalogExport(validExport()).environment, "production");
  assert.throws(() => validateModelCatalogExport({ ...validExport(), environment: "staging" }), /production/);
  assert.throws(() => validateModelCatalogExport({ ...validExport(), schemaVersion: 2 }), /schemaVersion/);
  const tampered = validExport();
  tampered.tables.ModelRegistryEntry[0].creditWeight = 1;
  assert.throws(() => validateModelCatalogExport(tampered), /digest/);
  const missingTable = validExport();
  delete missingTable.tables.ModelLifecycleWorkItemEvent;
  assert.throws(() => validateModelCatalogExport(missingTable), /ModelLifecycleWorkItemEvent/);
  const missingKey = validExport();
  missingKey.tables.ModelRegistryEntry = [{ name: "no id" }];
  missingKey.digest = exportDigest(missingKey.tables);
  assert.throws(() => validateModelCatalogExport(missingKey), /missing id/);
});

test("the weekly step runs on Sunday in UTC", () => {
  assert.equal(isModelCatalogEnvSyncDay(new Date("2026-11-08T03:00:00.000Z")), true);
  assert.equal(isModelCatalogEnvSyncDay(new Date("2026-11-09T03:00:00.000Z")), false);
  assert.equal(isModelCatalogEnvSyncDay(new Date("2026-11-07T23:30:00.000Z")), false);
});
