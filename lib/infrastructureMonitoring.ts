import "server-only";

import { prisma } from "@/lib/prisma";
import type {
  DatabaseInfrastructureSnapshot,
  InfrastructureDashboard,
  PrismaUsageInfrastructureSnapshot,
  R2InfrastructureSnapshot,
  RailwayInfrastructureSnapshot,
  RailwayUsageMeasurement,
} from "@/lib/infrastructureTypes";

const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
const CLOUDFLARE_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const PRISMA_MANAGEMENT_API_URL = "https://api.prisma.io/v1";
const MAX_EXTERNAL_RESPONSE_BYTES = 1_000_000;
const EXTERNAL_TIMEOUT_MS = 8_000;
const R2_STORAGE_ALLOWANCE_BYTES = 10 * 1024 * 1024 * 1024;
const R2_CLASS_A_ALLOWANCE = 1_000_000;
const R2_CLASS_B_ALLOWANCE = 10_000_000;
const RAILWAY_MEASUREMENTS = [
  "BACKUP_USAGE_GB",
  "CPU_USAGE",
  "CPU_USAGE_2",
  "DISK_USAGE_GB",
  "EPHEMERAL_DISK_USAGE_GB",
  "MEMORY_USAGE_GB",
  "NETWORK_RX_GB",
  "NETWORK_TX_GB",
] as const;

const R2_CLASS_A_ACTIONS = new Set([
  "listbuckets",
  "putbucket",
  "listobjects",
  "putobject",
  "copyobject",
  "completemultipartupload",
  "createmultipartupload",
  "lifecyclestoragetiertransition",
  "listmultipartuploads",
  "uploadpart",
  "uploadpartcopy",
  "listparts",
  "putbucketencryption",
  "putbucketcors",
  "putbucketlifecycleconfiguration",
]);

const R2_CLASS_B_ACTIONS = new Set([
  "headbucket",
  "headobject",
  "getobject",
  "usagesummary",
  "getbucketencryption",
  "getbucketlocation",
  "getbucketcors",
  "getbucketlifecycleconfiguration",
]);

const configured = (value: string | undefined) => Boolean(value?.trim());

const numeric = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const headerNumber = (value: string | null) => {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const percent = (value: number, allowance: number) =>
  Math.round((value / allowance) * 1_000) / 10;

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const safeExternalMessage = (value: unknown) =>
  typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, 240)
    : "External API request failed.";

const readBoundedJson = async (response: Response) => {
  const declaredLength = headerNumber(response.headers.get("content-length"));
  if (declaredLength !== null && declaredLength > MAX_EXTERNAL_RESPONSE_BYTES) {
    throw new Error("External API response exceeded the 1 MB safety limit.");
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_EXTERNAL_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("External API response exceeded the 1 MB safety limit.");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as unknown;
};

const railwaySnapshot = async (
  credit: { creditMicroUsd: bigint; note: string | null } | null
): Promise<RailwayInfrastructureSnapshot> => {
  const checkedAt = new Date().toISOString();
  const accountOrWorkspaceToken = process.env.RAILWAY_API_TOKEN?.trim();
  const projectToken = process.env.RAILWAY_PROJECT_TOKEN?.trim();
  const workspaceId = process.env.RAILWAY_WORKSPACE_ID?.trim();
  const projectId = process.env.RAILWAY_PROJECT_ID?.trim();
  // Project usage is the intended scope for this application. Prefer it when
  // both identifiers exist instead of allowing a stale workspace ID to win.
  const scope = projectId ? "project" : workspaceId ? "workspace" : "none";
  const token =
    scope === "project"
      ? projectToken || accountOrWorkspaceToken
      : accountOrWorkspaceToken;
  const configuredCreditMicroUsd = credit ? Number(credit.creditMicroUsd) : null;
  const base = {
    tokenConfigured: Boolean(token),
    scope: scope as RailwayInfrastructureSnapshot["scope"],
    configuredCreditMicroUsd,
    creditNote: credit?.note || null,
    measurements: [] as RailwayUsageMeasurement[],
    apiRateLimit: { limit: null, remaining: null, resetAt: null },
    checkedAt,
  };

  if (!token || scope === "none") {
    return {
      ...base,
      status: "unconfigured",
      message: !token
        ? "Add RAILWAY_API_TOKEN or RAILWAY_PROJECT_TOKEN to read Railway usage."
        : "Add RAILWAY_WORKSPACE_ID or RAILWAY_PROJECT_ID to select a billing scope.",
      projectedMonthCostMicroUsd: null,
      projectedBalanceMicroUsd: null,
    };
  }

  try {
    const response = await fetch(RAILWAY_GRAPHQL_URL, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        ...(scope === "project" && projectToken
          ? { "Project-Access-Token": projectToken }
          : { Authorization: `Bearer ${token}` }),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `
          query TomverseInfrastructureUsage(
            $measurements: [MetricMeasurement!]!
            $workspaceId: String
            $projectId: String
          ) {
            estimatedUsage(
              measurements: $measurements
              workspaceId: $workspaceId
              projectId: $projectId
              includeDeleted: false
            ) {
              measurement
              estimatedValue
              projectId
            }
          }
        `,
        variables: {
          measurements: RAILWAY_MEASUREMENTS,
          workspaceId: scope === "workspace" ? workspaceId || null : null,
          projectId: scope === "project" ? projectId || null : null,
        },
      }),
    });
    const payload = (await readBoundedJson(response)) as {
      data?: { estimatedUsage?: unknown };
      errors?: Array<{ message?: unknown }>;
    };
    if (!response.ok || payload.errors?.length) {
      throw new Error(
        safeExternalMessage(
          payload.errors?.[0]?.message || `Railway API returned ${response.status}.`
        )
      );
    }
    const rawRows = Array.isArray(payload.data?.estimatedUsage)
      ? payload.data.estimatedUsage
      : [];
    const measurements = rawRows.flatMap((row): RailwayUsageMeasurement[] => {
      if (!row || typeof row !== "object") return [];
      const record = row as Record<string, unknown>;
      const estimatedValue = numeric(record.estimatedValue);
      if (typeof record.measurement !== "string" || estimatedValue === null) return [];
      return [{
        measurement: record.measurement.slice(0, 80),
        estimatedValue,
        projectId: typeof record.projectId === "string" ? record.projectId : null,
      }];
    });
    const projectedUsd = measurements.reduce(
      (sum, measurement) => sum + Math.max(0, measurement.estimatedValue),
      0
    );
    const projectedMonthCostMicroUsd = Math.round(projectedUsd * 1_000_000);
    const projectedBalanceMicroUsd =
      configuredCreditMicroUsd === null
        ? null
        : configuredCreditMicroUsd - projectedMonthCostMicroUsd;
    const lowCredit =
      projectedBalanceMicroUsd !== null &&
      (projectedBalanceMicroUsd < 0 ||
        (configuredCreditMicroUsd !== null &&
          configuredCreditMicroUsd > 0 &&
          projectedBalanceMicroUsd / configuredCreditMicroUsd < 0.2));
    return {
      ...base,
      status:
        configuredCreditMicroUsd === null || lowCredit ? "warning" : "healthy",
      message:
        configuredCreditMicroUsd === null
          ? "Railway usage was synchronized; configure an opening credit to calculate projected balance."
          : lowCredit
            ? "Railway usage was synchronized, but projected remaining credit is below 20%."
            : "Railway projected billing usage was synchronized.",
      projectedMonthCostMicroUsd,
      projectedBalanceMicroUsd,
      measurements,
      apiRateLimit: {
        limit: headerNumber(response.headers.get("x-ratelimit-limit")),
        remaining: headerNumber(response.headers.get("x-ratelimit-remaining")),
        resetAt: response.headers.get("x-ratelimit-reset"),
      },
    };
  } catch (error) {
    return {
      ...base,
      status: "error",
      message: safeExternalMessage(error instanceof Error ? error.message : error),
      projectedMonthCostMicroUsd: null,
      projectedBalanceMicroUsd: null,
    };
  }
};

const prismaUsageSnapshot = async (): Promise<PrismaUsageInfrastructureSnapshot> => {
  const checkedAt = new Date().toISOString();
  const token = process.env.PRISMA_MANAGEMENT_API_TOKEN?.trim();
  const databaseId = process.env.PRISMA_DATABASE_ID?.trim();
  const operationsLimit = positiveInteger(
    process.env.PRISMA_OPERATIONS_LIMIT,
    1_000_000
  );
  const base = {
    tokenConfigured: Boolean(token),
    databaseIdConfigured: Boolean(databaseId),
    operationsUsed: null,
    operationsLimit,
    operationsAllowancePercent: null,
    storageGiB: null,
    periodStart: null,
    periodEnd: null,
    checkedAt,
  };
  if (!token || !databaseId) {
    return {
      ...base,
      status: "unconfigured",
      message: !token
        ? "Add PRISMA_MANAGEMENT_API_TOKEN to read Prisma Postgres usage."
        : "Add PRISMA_DATABASE_ID to select the monitored database.",
    };
  }

  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  try {
    const url = new URL(
      `/v1/databases/${encodeURIComponent(databaseId)}/usage`,
      PRISMA_MANAGEMENT_API_URL
    );
    url.searchParams.set("startDate", monthStart.toISOString());
    url.searchParams.set("endDate", now.toISOString());
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    const payload = (await readBoundedJson(response)) as {
      period?: { start?: unknown; end?: unknown };
      metrics?: {
        operations?: { used?: unknown };
        storage?: { used?: unknown };
      };
      error?: { message?: unknown };
    };
    if (!response.ok) {
      throw new Error(
        safeExternalMessage(
          payload?.error?.message || `Prisma Management API returned ${response.status}.`
        )
      );
    }
    const operationsUsed = numeric(payload.metrics?.operations?.used);
    const storageGiB = numeric(payload.metrics?.storage?.used);
    if (operationsUsed === null) {
      throw new Error("Prisma usage response did not contain operations.used.");
    }
    const operationsAllowancePercent = percent(
      operationsUsed,
      operationsLimit
    );
    return {
      ...base,
      status: operationsAllowancePercent >= 80 ? "warning" : "healthy",
      message:
        operationsAllowancePercent >= 80
          ? "Prisma Postgres operations are above 80% of the configured monthly limit."
          : "Prisma Postgres operation usage was synchronized.",
      operationsUsed,
      operationsAllowancePercent,
      storageGiB,
      periodStart:
        typeof payload.period?.start === "string" ? payload.period.start : null,
      periodEnd:
        typeof payload.period?.end === "string" ? payload.period.end : null,
    };
  } catch (error) {
    return {
      ...base,
      status: "error",
      message: safeExternalMessage(error instanceof Error ? error.message : error),
    };
  }
};

const r2Snapshot = async (): Promise<R2InfrastructureSnapshot> => {
  const checkedAt = new Date().toISOString();
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const bucketName = process.env.R2_BUCKET_NAME?.trim();
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const objectCredentialsConfigured =
    configured(accountId) &&
    configured(bucketName) &&
    configured(process.env.R2_ACCESS_KEY_ID) &&
    configured(process.env.R2_SECRET_ACCESS_KEY);
  const base = {
    bucketName: bucketName || null,
    objectCredentialsConfigured,
    analyticsTokenConfigured: Boolean(token),
    storageBytes: null,
    metadataBytes: null,
    objectCount: null,
    pendingUploads: null,
    classAOperations: null,
    classBOperations: null,
    unclassifiedOperations: null,
    storageAllowancePercent: null,
    classAAllowancePercent: null,
    classBAllowancePercent: null,
    checkedAt,
  };

  if (!accountId || !bucketName || !token) {
    return {
      ...base,
      status: "unconfigured",
      message: !objectCredentialsConfigured
        ? "R2 object credentials are incomplete."
        : "Uploads are configured; add CLOUDFLARE_API_TOKEN for storage and operation analytics.",
    };
  }

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  try {
    const response = await fetch(CLOUDFLARE_GRAPHQL_URL, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `
          query TomverseR2Audit(
            $accountTag: string!
            $startDate: Time!
            $endDate: Time!
            $bucketName: string!
          ) {
            viewer {
              accounts(filter: { accountTag: $accountTag }) {
                storage: r2StorageAdaptiveGroups(
                  limit: 1
                  filter: {
                    datetime_geq: $startDate
                    datetime_leq: $endDate
                    bucketName: $bucketName
                  }
                  orderBy: [datetime_DESC]
                ) {
                  max { objectCount uploadCount payloadSize metadataSize }
                  dimensions { datetime }
                }
                operations: r2OperationsAdaptiveGroups(
                  limit: 1000
                  filter: {
                    datetime_geq: $startDate
                    datetime_leq: $endDate
                    bucketName: $bucketName
                  }
                ) {
                  sum { requests }
                  dimensions { actionType }
                }
              }
            }
          }
        `,
        variables: {
          accountTag: accountId,
          startDate: monthStart.toISOString(),
          endDate: now.toISOString(),
          bucketName,
        },
      }),
    });
    const payload = (await readBoundedJson(response)) as {
      data?: {
        viewer?: {
          accounts?: Array<{
            storage?: Array<{
              max?: Record<string, unknown>;
            }>;
            operations?: Array<{
              sum?: { requests?: unknown };
              dimensions?: { actionType?: unknown };
            }>;
          }>;
        };
      };
      errors?: Array<{ message?: unknown }>;
    };
    if (!response.ok || payload.errors?.length) {
      throw new Error(
        safeExternalMessage(
          payload.errors?.[0]?.message || `Cloudflare API returned ${response.status}.`
        )
      );
    }
    const account = payload.data?.viewer?.accounts?.[0];
    const storage = account?.storage?.[0]?.max || {};
    const storageBytes = numeric(storage.payloadSize) || 0;
    const metadataBytes = numeric(storage.metadataSize) || 0;
    let classAOperations = 0;
    let classBOperations = 0;
    let unclassifiedOperations = 0;
    for (const operation of account?.operations || []) {
      const action = operation.dimensions?.actionType;
      const requests = numeric(operation.sum?.requests) || 0;
      if (typeof action !== "string") {
        unclassifiedOperations += requests;
      } else if (
        R2_CLASS_A_ACTIONS.has(action.replace(/[^a-z0-9]/gi, "").toLowerCase())
      ) {
        classAOperations += requests;
      } else if (
        R2_CLASS_B_ACTIONS.has(action.replace(/[^a-z0-9]/gi, "").toLowerCase())
      ) {
        classBOperations += requests;
      } else {
        unclassifiedOperations += requests;
      }
    }
    const storageAllowancePercent = percent(
      storageBytes + metadataBytes,
      R2_STORAGE_ALLOWANCE_BYTES
    );
    const classAAllowancePercent = percent(
      classAOperations,
      R2_CLASS_A_ALLOWANCE
    );
    const classBAllowancePercent = percent(
      classBOperations,
      R2_CLASS_B_ALLOWANCE
    );
    const nearingReferenceAllowance = Math.max(
      storageAllowancePercent,
      classAAllowancePercent,
      classBAllowancePercent
    ) >= 80;
    return {
      ...base,
      status: nearingReferenceAllowance ? "warning" : "healthy",
      message: nearingReferenceAllowance
        ? "R2 analytics were synchronized; at least one selected-bucket metric is above 80% of its Standard free-tier reference."
        : "Cloudflare R2 analytics were synchronized.",
      storageBytes,
      metadataBytes,
      objectCount: numeric(storage.objectCount) || 0,
      pendingUploads: numeric(storage.uploadCount) || 0,
      classAOperations,
      classBOperations,
      unclassifiedOperations,
      storageAllowancePercent,
      classAAllowancePercent,
      classBAllowancePercent,
    };
  } catch (error) {
    return {
      ...base,
      status: "error",
      message: safeExternalMessage(error instanceof Error ? error.message : error),
    };
  }
};

const databaseSnapshot = async (): Promise<DatabaseInfrastructureSnapshot> => {
  const checkedAt = new Date().toISOString();
  try {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const errorCutoff = new Date(now.getTime() - 30 * 86_400_000);
    const [activeSessions, conversations, messages, usageBuckets, providerErrors24h, providerErrorsPendingCleanup] =
      await Promise.all([
        prisma.session.count({ where: { expires: { gt: now } } }),
        prisma.conversation.count(),
        prisma.message.count(),
        prisma.chatUsageBucket.count(),
        prisma.providerErrorEvent.count({ where: { createdAt: { gte: dayAgo } } }),
        prisma.providerErrorEvent.count({ where: { createdAt: { lt: errorCutoff } } }),
      ]);
    return {
      status: providerErrorsPendingCleanup > 0 ? "warning" : "healthy",
      message:
        providerErrorsPendingCleanup > 0
          ? "Provider error events are waiting for retention cleanup."
          : "Database connectivity and operational counts are healthy.",
      activeSessions,
      conversations,
      messages,
      usageBuckets,
      providerErrors24h,
      providerErrorsPendingCleanup,
      checkedAt,
    };
  } catch (error) {
    return {
      status: "error",
      message: safeExternalMessage(error instanceof Error ? error.message : error),
      activeSessions: 0,
      conversations: 0,
      messages: 0,
      usageBuckets: 0,
      providerErrors24h: 0,
      providerErrorsPendingCleanup: 0,
      checkedAt,
    };
  }
};

export async function getInfrastructureDashboard(): Promise<InfrastructureDashboard> {
  const credit = await prisma.infrastructureCreditConfig
    .findUnique({
      where: { service: "railway" },
      select: { creditMicroUsd: true, note: true },
    })
    .catch(() => null);
  const [railway, r2, database, prismaUsage] = await Promise.all([
    railwaySnapshot(credit),
    r2Snapshot(),
    databaseSnapshot(),
    prismaUsageSnapshot(),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    railway,
    r2,
    database,
    prismaUsage,
  };
}
