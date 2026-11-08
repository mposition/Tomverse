import "server-only";

import { Prisma } from "@prisma/client";
import { writeModelCatalogEnvSyncSystemAudit } from "@/lib/modelCatalogEnvSyncSystemAudit";
import {
  MODEL_CATALOG_ENV_SYNC_SCHEMA_VERSION,
  MODEL_CATALOG_EXPORT_PATH,
  MODEL_CATALOG_SYNC_SOURCE_ORIGIN,
  MODEL_CATALOG_SYNC_TABLES,
  exportDigest,
  isModelCatalogEnvSyncDay,
  normalizeSyncRow,
  planModelCatalogEnvSync,
  summarizeSyncPlan,
  validateModelCatalogExport,
  type ModelCatalogExport,
  type SyncRow,
  type SyncTableSpec,
  type SyncTables,
} from "@/lib/modelCatalogEnvSyncCore";
import { invalidateImageModelCatalog } from "@/lib/modelCatalog";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { prisma } from "@/lib/prisma";
import { resolveDeploymentEnvironment } from "@/lib/deploymentEnvironment";

/**
 * The catalogue's read secret, the same value in production (which checks it)
 * and in staging and dev (which send it). It reads the catalogue tables and
 * nothing else; it is not a database credential.
 */
export const modelCatalogExportSecret = (env: NodeJS.ProcessEnv = process.env) => {
  const secret = env.MODEL_CATALOG_EXPORT_SECRET ?? "";
  return secret.length >= 32 ? secret : null;
};

/** Off unless set: without it a run reads and plans, and writes nothing. */
export const modelCatalogEnvSyncApplyOn = (env: NodeJS.ProcessEnv = process.env) =>
  env.MODEL_CATALOG_ENV_SYNC_APPLY === "true";

type Delegate = {
  findMany(args?: unknown): Promise<SyncRow[]>;
  createMany(args: { data: SyncRow[]; skipDuplicates?: boolean }): Promise<unknown>;
  updateMany(args: { where: SyncRow; data: SyncRow }): Promise<unknown>;
};

const delegate = (client: Prisma.TransactionClient | typeof prisma, spec: SyncTableSpec) =>
  (client as unknown as Record<string, Delegate>)[spec.delegate];

async function readTables(client: Prisma.TransactionClient | typeof prisma): Promise<SyncTables> {
  const tables: SyncTables = {};
  for (const spec of MODEL_CATALOG_SYNC_TABLES) {
    const rows = await delegate(client, spec).findMany();
    tables[spec.model] = rows
      .map((row) => normalizeSyncRow(spec, row))
      .sort((a, b) => {
        const left = String(a.id ?? spec.key.map((name) => a[name]).join("\u0000"));
        const right = String(b.id ?? spec.key.map((name) => b[name]).join("\u0000"));
        return left < right ? -1 : left > right ? 1 : 0;
      });
  }
  return tables;
}

/**
 * Production's side: every synced table, normalised and digested. All reads
 * share one RepeatableRead snapshot, so a work item and the events that point
 * at it come from the same moment -- read table by table, an item committed
 * between two reads would send its events without it, and the receiving
 * insert would fail on the foreign key.
 */
export async function exportModelCatalog(now = new Date()): Promise<ModelCatalogExport> {
  const tables = await prisma.$transaction((tx) => readTables(tx), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    timeout: 45_000,
    maxWait: 10_000,
  });
  return {
    schemaVersion: MODEL_CATALOG_ENV_SYNC_SCHEMA_VERSION,
    environment: "production",
    exportedAt: now.toISOString(),
    digest: exportDigest(tables),
    tables,
  };
}

/** Wire form back to what Prisma writes: ISO strings to Dates, JSON null to DbNull. */
const toWrite = (spec: SyncTableSpec, row: SyncRow): SyncRow => {
  const out: SyncRow = {};
  for (const [name, value] of Object.entries(row)) {
    if (spec.dateFields.includes(name)) {
      out[name] = typeof value === "string" ? new Date(value) : value;
    } else if (spec.jsonFields.includes(name)) {
      out[name] = value === null ? Prisma.DbNull : value;
    } else {
      out[name] = value;
    }
  }
  return out;
};

const SOURCE_FETCH_TIMEOUT_MS = 60_000;
const SOURCE_MAX_BYTES = 25 * 1024 * 1024;

async function fetchProductionExport(secret: string): Promise<ModelCatalogExport> {
  const url = new URL(MODEL_CATALOG_EXPORT_PATH, MODEL_CATALOG_SYNC_SOURCE_ORIGIN);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${secret}` },
    cache: "no-store",
    signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Production catalogue export answered ${response.status}.`);
  }
  const body = await response.text();
  if (body.length > SOURCE_MAX_BYTES) {
    throw new Error("Production catalogue export is larger than the sync accepts.");
  }
  return validateModelCatalogExport(JSON.parse(body));
}

/**
 * Retries a write the database rolled back because a concurrent write made
 * its plan stale (serialization failure, or a unique key the plan did not
 * see). Both outcomes are known -- nothing committed -- so a retry re-plans
 * from scratch rather than repeating an unknown write.
 */
const RETRYABLE_PRISMA_CODES = new Set(["P2034", "P2002"]);
export async function applyWithRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const code =
        error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined;
      if (!code || !RETRYABLE_PRISMA_CODES.has(code) || attempt >= attempts) throw error;
    }
  }
}

export type ModelCatalogEnvSyncResult =
  | { status: "skipped"; reason: "production" | "environment" | "export_secret_missing" }
  | {
      status: "planned" | "applied";
      environment: string;
      sourceExportedAt: string;
      sourceDigest: string;
      auditLogId: string | null;
      plan: ReturnType<typeof summarizeSyncPlan>;
    };

/**
 * staging's and dev's side: read production's export, plan against this
 * database, and -- only with MODEL_CATALOG_ENV_SYNC_APPLY=true -- write the
 * plan and its audit entry in one transaction.
 */
export async function runModelCatalogEnvSync(
  env: NodeJS.ProcessEnv = process.env
): Promise<ModelCatalogEnvSyncResult> {
  const environment = resolveDeploymentEnvironment(env);
  if (environment === "production") return { status: "skipped", reason: "production" };
  if (environment !== "staging" && environment !== "dev") {
    return { status: "skipped", reason: "environment" };
  }
  const secret = modelCatalogExportSecret(env);
  if (!secret) return { status: "skipped", reason: "export_secret_missing" };

  const source = await fetchProductionExport(secret);
  const apply = modelCatalogEnvSyncApplyOn(env);

  if (!apply) {
    const plan = planModelCatalogEnvSync(source.tables, await readTables(prisma));
    return {
      status: "planned",
      environment,
      sourceExportedAt: source.exportedAt,
      sourceDigest: source.digest,
      auditLogId: null,
      plan: summarizeSyncPlan(plan),
    };
  }

  const { summary, auditLogId } = await applyWithRetry(() => prisma.$transaction(
    async (tx) => {
      // Planned inside the transaction, against what it is about to change.
      // Serializable: if this environment's own discovery inserts a row the
      // plan did not see (a work item under the same key with its own id),
      // the transaction fails and is planned again, instead of writing events
      // that point at a work item id that was never inserted.
      const plan = planModelCatalogEnvSync(source.tables, await readTables(tx));
      const summary = summarizeSyncPlan(plan);
      if (plan.totals.create === 0 && plan.totals.update === 0) {
        return { summary, auditLogId: null };
      }
      for (const table of plan.tables) {
        const spec = MODEL_CATALOG_SYNC_TABLES.find((item) => item.model === table.model)!;
        const client = delegate(tx, spec);
        if (table.create.length > 0) {
          // No skipDuplicates: a duplicate means the plan is stale, and a
          // silently skipped row would leave its references dangling.
          await client.createMany({ data: table.create.map((row) => toWrite(spec, row)) });
        }
        for (const change of table.update) {
          await client.updateMany({ where: change.where, data: toWrite(spec, change.data) });
        }
      }
      const auditLogId = await writeModelCatalogEnvSyncSystemAudit(tx, {
        targetId: source.digest,
        summary: `Model catalogue copied from production (${summary.totals.create} created, ${summary.totals.update} updated).`,
        metadata: {
          environment,
          sourceExportedAt: source.exportedAt,
          sourceDigest: source.digest,
          totals: summary.totals,
          tables: summary.tables,
        },
      });
      return { summary, auditLogId };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 180_000,
      maxWait: 30_000,
    }
  ));
  invalidateImageModelCatalog();
  return {
    status: "applied",
    environment,
    sourceExportedAt: source.exportedAt,
    sourceDigest: source.digest,
    auditLogId,
    plan: summary,
  };
}

/**
 * The Maintenance Cron's weekly step. Does nothing outside Sunday (UTC) or
 * outside staging and dev; logs one line with the counts, and reports a
 * failure as an incident instead of throwing into the cleanup.
 */
export async function runWeeklyModelCatalogEnvSync(now = new Date()) {
  if (!isModelCatalogEnvSyncDay(now)) return null;
  const environment = resolveDeploymentEnvironment();
  if (environment !== "staging" && environment !== "dev") return null;
  try {
    const result = await runModelCatalogEnvSync();
    console.info(
      JSON.stringify({
        event: "model_catalog_env_sync",
        status: result.status,
        ...(result.status === "skipped"
          ? { reason: result.reason }
          : { totals: result.plan.totals, sourceExportedAt: result.sourceExportedAt }),
        at: new Date().toISOString(),
      })
    );
    return result;
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "model_catalog_env_sync_failed",
        reason: error instanceof Error ? error.message : "unknown",
        at: new Date().toISOString(),
      })
    );
    await reportOperationalIncident({
      code: "MODEL_CATALOG_ENV_SYNC_FAILED",
      title: "Weekly model catalogue copy from production failed",
      error,
      severity: "warning",
      cooldownMs: 24 * 60 * 60 * 1_000,
      context: { component: "model-catalog-env-sync", environment },
    }).catch(() => undefined);
    return null;
  }
}
