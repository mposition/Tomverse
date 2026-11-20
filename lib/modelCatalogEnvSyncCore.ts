// Weekly copy of production's model catalogue into staging (Test) and dev.
//
// Pure: no database, no environment, no framework, so the plan can be tested
// row by row. lib/modelCatalogEnvSync.ts does the reads and writes.
//
// Owner decision 2026-11-08: the registry, the image/coding catalogue and the
// discovery tables travel together -- a lower environment with production's
// registry but its own discovery queue disagrees with itself (work items point
// at registry rows that are not there, candidates already adopted in
// production show as new).
//
// What the copy never does:
//   - delete. A row only the lower environment has (a model being tried on
//     develop, a work item it opened itself) is kept and counted as localOnly;
//   - rewrite an append-only row. Price revisions and work-item events are
//     inserted when missing and otherwise left alone, as their triggers and
//     comments require;
//   - carry a user id. User ids are per environment, so updatedById, actorId
//     and reviewerId stay as the lower environment has them; the e-mail that
//     travels with each of them says who did it in production.
// ModelCatalogSnapshot is not copied: it is immutable, and each environment
// publishes its own.

import { createHash } from "node:crypto";

export const MODEL_CATALOG_ENV_SYNC_SCHEMA_VERSION = 1 as const;

export type SyncRow = Record<string, unknown>;

export type SyncTableSpec = {
  /** Prisma model name, as in prisma/schema.prisma. */
  readonly model: string;
  /** The Prisma client delegate. */
  readonly delegate: string;
  /** Fields that identify a row across environments. */
  readonly key: readonly string[];
  /** Fields copied and compared. Includes the key fields. */
  readonly fields: readonly string[];
  /** DateTime fields among `fields` (ISO strings on the wire). */
  readonly dateFields: readonly string[];
  /** Json fields among `fields` (a null must be written as DbNull). */
  readonly jsonFields: readonly string[];
  /**
   * Fields deliberately left out, each for a stated reason. Together with
   * `fields` and `createId` this is every scalar column of the model, which
   * tests/modelCatalogEnvSyncCore.test.mjs checks against the schema, so a new
   * column has to be placed in one list or the other.
   */
  readonly excluded: readonly string[];
  /** The row id is copied on create only, never compared or updated. */
  readonly createId: boolean;
  /** Insert missing rows, never update existing ones. */
  readonly appendOnly: boolean;
};

const TIMESTAMPS = ["createdAt", "updatedAt"] as const;

/** Order matters: work items before their events. */
export const MODEL_CATALOG_SYNC_TABLES: readonly SyncTableSpec[] = [
  {
    model: "ModelRegistryEntry",
    delegate: "modelRegistryEntry",
    key: ["id"],
    fields: [
      "id", "name", "apiModel", "provider", "apiBaseUrl", "apiKeyEnvName", "icon",
      "bestFor", "minimumPlan", "usageClass", "creditWeight", "publiclyListed",
      "enabled", "status", "operationalReason", "userVisibleNote",
      "replacementModelId", "catalogDeleted", "reasoning", "contextWindowTokens",
      "supportsImage", "supportsNativePdf", "webSearchOverride", "fileToolsOverride", "maxImages",
      "maxBase64ImagePayloadBytes", "maxOutputTokens", "reservationOutputTokens",
      "inputUsdPerMillionTokens", "outputUsdPerMillionTokens",
      "cachedInputPriceMultiplier", "sortOrder", "updatedByEmail",
    ],
    dateFields: [],
    jsonFields: [],
    excluded: ["updatedById", ...TIMESTAMPS],
    createId: false,
    appendOnly: false,
  },
  {
    model: "ModelOverride",
    delegate: "modelOverride",
    key: ["modelId"],
    fields: ["modelId", "status", "reason", "visibleNote", "updatedByEmail"],
    dateFields: [],
    jsonFields: [],
    excluded: ["updatedById", ...TIMESTAMPS],
    createId: false,
    appendOnly: false,
  },
  {
    model: "ModelCatalogEntry",
    delegate: "modelCatalogEntry",
    key: ["category", "modelId"],
    fields: [
      "category", "modelId", "enabled", "holdReason", "sortOrder", "profile",
      "draft", "draftSource", "draftCreatedAt", "updatedByEmail",
    ],
    dateFields: ["draftCreatedAt"],
    jsonFields: ["profile", "draft"],
    excluded: ["updatedById", ...TIMESTAMPS],
    createId: false,
    appendOnly: false,
  },
  {
    model: "ModelCatalogPriceRevision",
    delegate: "modelCatalogPriceRevision",
    key: ["category", "modelId", "pricingVersion"],
    fields: [
      "category", "modelId", "pricingVersion", "prices", "verification",
      "effectiveFrom", "actorEmail", "createdAt",
    ],
    dateFields: ["effectiveFrom", "createdAt"],
    jsonFields: ["prices", "verification"],
    excluded: ["actorId"],
    createId: true,
    appendOnly: true,
  },
  {
    model: "ProviderModelCatalogEntry",
    delegate: "providerModelCatalogEntry",
    key: ["provider", "apiModel"],
    fields: [
      "provider", "apiModel", "modelRegistryId", "displayName", "status",
      "firstSeenAt", "lastSeenAt", "lastCheckedAt", "missingSinceAt",
      "consecutiveSeen", "consecutiveMissing", "lifecycle", "metadata",
    ],
    dateFields: ["firstSeenAt", "lastSeenAt", "lastCheckedAt", "missingSinceAt"],
    jsonFields: ["metadata"],
    excluded: [...TIMESTAMPS],
    createId: true,
    appendOnly: false,
  },
  {
    model: "ProviderModelDocEvidence",
    delegate: "providerModelDocEvidence",
    key: ["provider", "apiModel"],
    fields: [
      "provider", "apiModel", "status", "sources", "parserVersion", "fields",
      "problems", "fetchedAt",
    ],
    dateFields: ["fetchedAt"],
    jsonFields: ["sources", "fields", "problems"],
    excluded: [...TIMESTAMPS],
    createId: true,
    appendOnly: false,
  },
  {
    model: "ModelLifecycleWorkItem",
    delegate: "modelLifecycleWorkItem",
    key: ["provider", "apiModel", "action"],
    fields: [
      "provider", "apiModel", "modelId", "catalogEntryId", "action", "status",
      "severity", "predecessorModelId", "replacementModelId", "recommendation",
      "confidence", "evidence", "unknowns", "blockers", "pendingValidations",
      "reviewerEmail", "decision", "decisionReason", "decidedAt", "ownerEmail",
      "dueAt", "deferredUntil", "linkedIssueUrl", "linkedPrUrl",
      "linkedDeploymentId", "implementationEvidence", "validationEvidence",
      "communicationRequired", "firstSeenAt", "completedAt", "closedAt",
    ],
    dateFields: ["decidedAt", "dueAt", "deferredUntil", "firstSeenAt", "completedAt", "closedAt"],
    jsonFields: [
      "evidence", "unknowns", "blockers", "pendingValidations",
      "implementationEvidence", "validationEvidence",
    ],
    excluded: ["reviewerId", ...TIMESTAMPS],
    createId: true,
    appendOnly: false,
  },
  {
    model: "ModelLifecycleWorkItemEvent",
    delegate: "modelLifecycleWorkItemEvent",
    key: ["id"],
    fields: [
      "id", "workItemId", "occurredAt", "actorEmail", "fromStatus", "toStatus",
      "note", "evidence", "decision", "reasonCode", "operatorReason",
      "analysisSnapshot",
    ],
    dateFields: ["occurredAt"],
    jsonFields: ["evidence"],
    excluded: [],
    createId: false,
    appendOnly: true,
  },
];

export type SyncTables = Record<string, SyncRow[]>;

export type ModelCatalogExport = {
  schemaVersion: typeof MODEL_CATALOG_ENV_SYNC_SCHEMA_VERSION;
  environment: "production";
  exportedAt: string;
  digest: string;
  tables: SyncTables;
};

export const canonicalJson = (value: unknown): string => {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
};

export const exportDigest = (tables: SyncTables): string =>
  createHash("sha256").update(canonicalJson(tables)).digest("hex");

/** A database row reduced to what travels: Dates as ISO strings, undefined as null. */
export const normalizeSyncRow = (spec: SyncTableSpec, row: SyncRow): SyncRow => {
  const out: SyncRow = {};
  const names = spec.createId ? ["id", ...spec.fields] : spec.fields;
  for (const name of names) {
    const value = row[name];
    out[name] =
      value instanceof Date ? value.toISOString() : value === undefined ? null : value;
  }
  return out;
};

export const syncRowKey = (spec: SyncTableSpec, row: SyncRow): string =>
  canonicalJson(spec.key.map((name) => row[name] ?? null));

/**
 * The fields a source row carries that this environment also knows. dev runs
 * develop, which can have a column production's code does not export yet: a
 * field missing from the row is left as this environment has it, never
 * written as null. A field this environment does not know is dropped.
 */
const carried = (spec: SyncTableSpec, row: SyncRow): string[] =>
  spec.fields.filter((name) => Object.prototype.hasOwnProperty.call(row, name));

const comparable = (fields: readonly string[], row: SyncRow): string =>
  canonicalJson(fields.map((name) => row[name] ?? null));

/** A source row's own data, without the key and the create-only id. */
const updateData = (spec: SyncTableSpec, fields: readonly string[], row: SyncRow): SyncRow =>
  Object.fromEntries(
    fields.filter((name) => !spec.key.includes(name)).map((name) => [name, row[name] ?? null])
  );

const createData = (spec: SyncTableSpec, fields: readonly string[], row: SyncRow): SyncRow =>
  Object.fromEntries(
    [...(spec.createId ? ["id"] : []), ...fields].map((name) => [name, row[name] ?? null])
  );

export type TablePlan = {
  model: string;
  create: SyncRow[];
  update: { where: SyncRow; data: SyncRow }[];
  unchanged: number;
  /** Append-only rows whose key exists locally with different content. Left alone. */
  conflicts: number;
  /** Rows only the lower environment has. Kept. */
  localOnly: number;
  /** Rows of a model whose prices here differ from production's (see heldPricedModels). Left alone. */
  held: number;
};

export type SyncPlan = {
  tables: TablePlan[];
  totals: {
    create: number;
    update: number;
    unchanged: number;
    conflicts: number;
    localOnly: number;
    held: number;
  };
  /** The catalogue models held back, as "category:modelId". */
  heldModels: string[];
};

const specFor = (model: string): SyncTableSpec => {
  const spec = MODEL_CATALOG_SYNC_TABLES.find((item) => item.model === model);
  if (!spec) throw new Error(`No sync spec for ${model}.`);
  return spec;
};

/**
 * Rows in two tables point at rows of another by id, and ids are per
 * environment: ModelLifecycleWorkItem.catalogEntryId at a catalogue
 * observation, ModelLifecycleWorkItemEvent.workItemId at a work item. A source
 * id is turned into the id the same row (same key) has locally, or kept when
 * the row is being created here, since a created row takes the source id.
 */
export const referenceTranslator = (model: string, source: SyncTables, local: SyncTables) => {
  const spec = specFor(model);
  const keyBySourceId = new Map<string, string>();
  for (const row of source[model] ?? []) keyBySourceId.set(String(row.id), syncRowKey(spec, row));
  const localIdByKey = new Map<string, string>();
  for (const row of local[model] ?? []) localIdByKey.set(syncRowKey(spec, row), String(row.id));
  return (sourceId: unknown): unknown => {
    if (typeof sourceId !== "string") return sourceId;
    const key = keyBySourceId.get(sourceId);
    if (key === undefined) return sourceId;
    return localIdByKey.get(key) ?? sourceId;
  };
};

/**
 * Catalogue models whose price history here is not a subset of production's:
 * a revision only this environment has, or one under production's
 * pricingVersion with other content. Production's execution profile must not
 * be installed over prices that were set for another profile -- the latest
 * revision would still price it, which is what the admin editor refuses
 * (execution_profile_priced). So such a model's catalogue row and its price
 * revisions are left exactly as they are here, and counted as held.
 */
const pricedModel = (row: SyncRow) => `${String(row.category)}:${String(row.modelId)}`;

export const heldPricedModels = (source: SyncTables, local: SyncTables): Set<string> => {
  const spec = specFor("ModelCatalogPriceRevision");
  const sourceByKey = new Map<string, SyncRow>();
  for (const row of source.ModelCatalogPriceRevision ?? []) sourceByKey.set(syncRowKey(spec, row), row);
  const held = new Set<string>();
  for (const row of local.ModelCatalogPriceRevision ?? []) {
    const match = sourceByKey.get(syncRowKey(spec, row));
    const fields = match ? carried(spec, match) : [];
    if (!match || comparable(fields, match) !== comparable(fields, row)) held.add(pricedModel(row));
  }
  return held;
};

const PRICED_TABLES = new Set(["ModelCatalogEntry", "ModelCatalogPriceRevision"]);

export const planModelCatalogEnvSync = (source: SyncTables, local: SyncTables): SyncPlan => {
  const held = heldPricedModels(source, local);
  const isHeld = (model: string, row: SyncRow) =>
    PRICED_TABLES.has(model) && held.has(pricedModel(row));
  const entryId = referenceTranslator("ProviderModelCatalogEntry", source, local);
  const workItemId = referenceTranslator("ModelLifecycleWorkItem", source, local);
  const remap = (model: string, row: SyncRow): SyncRow =>
    model === "ModelLifecycleWorkItem"
      ? { ...row, catalogEntryId: entryId(row.catalogEntryId) }
      : model === "ModelLifecycleWorkItemEvent"
        ? { ...row, workItemId: workItemId(row.workItemId) }
        : row;

  const tables = MODEL_CATALOG_SYNC_TABLES.map((spec): TablePlan => {
    const localByKey = new Map<string, SyncRow>();
    for (const row of local[spec.model] ?? []) localByKey.set(syncRowKey(spec, row), row);
    const plan: TablePlan = {
      model: spec.model,
      create: [],
      update: [],
      unchanged: 0,
      conflicts: 0,
      localOnly: 0,
      held: 0,
    };
    const seen = new Set<string>();
    for (const raw of source[spec.model] ?? []) {
      const row = remap(spec.model, raw);
      const key = syncRowKey(spec, row);
      seen.add(key);
      const existing = localByKey.get(key);
      const fields = carried(spec, row);
      if (isHeld(spec.model, row)) {
        plan.held += 1;
      } else if (!existing) {
        plan.create.push(createData(spec, fields, row));
      } else if (comparable(fields, existing) === comparable(fields, row)) {
        plan.unchanged += 1;
      } else if (spec.appendOnly) {
        plan.conflicts += 1;
      } else {
        plan.update.push({
          where: Object.fromEntries(spec.key.map((name) => [name, row[name]])),
          data: updateData(spec, fields, row),
        });
      }
    }
    for (const key of localByKey.keys()) if (!seen.has(key)) plan.localOnly += 1;
    return plan;
  });

  const totals = { create: 0, update: 0, unchanged: 0, conflicts: 0, localOnly: 0, held: 0 };
  for (const plan of tables) {
    totals.create += plan.create.length;
    totals.update += plan.update.length;
    totals.unchanged += plan.unchanged;
    totals.conflicts += plan.conflicts;
    totals.localOnly += plan.localOnly;
    totals.held += plan.held;
  }
  return { tables, totals, heldModels: [...held].sort() };
};

/**
 * The reference each referencing table carries, and the table it points at.
 * The apply step re-reads the parent's ids after writing it and rebinds these,
 * because this environment's own discovery may have inserted a parent row
 * under the same key, with its own id, after the plan was read.
 */
export const SYNC_REFERENCES: Readonly<Record<string, { field: string; parent: string }>> = {
  ModelLifecycleWorkItem: { field: "catalogEntryId", parent: "ProviderModelCatalogEntry" },
  ModelLifecycleWorkItemEvent: { field: "workItemId", parent: "ModelLifecycleWorkItem" },
};

/** A row's key fields, the `where` of an update. */
export const syncRowWhere = (spec: SyncTableSpec, row: SyncRow): SyncRow =>
  Object.fromEntries(spec.key.map((name) => [name, row[name]]));

/** A row's fields other than its key and its id, the `data` of an update. */
export const syncRowUpdateData = (spec: SyncTableSpec, row: SyncRow): SyncRow =>
  Object.fromEntries(
    Object.entries(row).filter(([name]) => name !== "id" && !spec.key.includes(name))
  );

/** Counts only: what the report, the response and the audit entry carry. */
export const summarizeSyncPlan = (plan: SyncPlan) => ({
  totals: plan.totals,
  tables: Object.fromEntries(
    plan.tables.map((table) => [
      table.model,
      {
        create: table.create.length,
        update: table.update.length,
        unchanged: table.unchanged,
        conflicts: table.conflicts,
        localOnly: table.localOnly,
        held: table.held,
      },
    ])
  ),
  heldModels: plan.heldModels,
});

/**
 * The one check on what production sent before anything is written: the shape
 * this code expects, every key field present, and a digest that matches the
 * rows. Throws with a reason; never repairs.
 */
export const validateModelCatalogExport = (value: unknown): ModelCatalogExport => {
  if (!value || typeof value !== "object") throw new Error("Export is not an object.");
  const payload = value as Partial<ModelCatalogExport>;
  if (payload.schemaVersion !== MODEL_CATALOG_ENV_SYNC_SCHEMA_VERSION) {
    throw new Error(`Export schemaVersion ${String(payload.schemaVersion)} is not supported.`);
  }
  if (payload.environment !== "production") throw new Error("Export is not from production.");
  if (typeof payload.exportedAt !== "string" || Number.isNaN(Date.parse(payload.exportedAt))) {
    throw new Error("Export has no exportedAt.");
  }
  const tables = payload.tables;
  if (!tables || typeof tables !== "object") throw new Error("Export has no tables.");
  for (const spec of MODEL_CATALOG_SYNC_TABLES) {
    const rows = (tables as SyncTables)[spec.model];
    if (!Array.isArray(rows)) throw new Error(`Export has no ${spec.model} rows.`);
    for (const row of rows) {
      if (!row || typeof row !== "object") throw new Error(`${spec.model} has a non-object row.`);
      for (const name of spec.createId ? ["id", ...spec.key] : spec.key) {
        if (typeof row[name] !== "string" || row[name] === "") {
          throw new Error(`${spec.model} row is missing ${name}.`);
        }
      }
    }
  }
  if (payload.digest !== exportDigest(tables as SyncTables)) {
    throw new Error("Export digest does not match its rows.");
  }
  return payload as ModelCatalogExport;
};

/** Sunday in UTC: the Maintenance Cron's 03:00 UTC run, 13:00 in Brisbane. */
export const isModelCatalogEnvSyncDay = (now: Date): boolean => now.getUTCDay() === 0;

/** The one host a lower environment reads the catalogue from. */
export const MODEL_CATALOG_SYNC_SOURCE_ORIGIN = "https://tomverse.app";
export const MODEL_CATALOG_EXPORT_PATH = "/api/internal/model-catalog/export";
