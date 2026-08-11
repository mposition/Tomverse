import "server-only";

import { prisma } from "@/lib/prisma";
import {
  RAILWAY_USAGE_MONITOR_DISABLED_MESSAGE,
  type DatabaseInfrastructureSnapshot,
  type InfrastructureDashboard,
  type PrismaUsageInfrastructureSnapshot,
  type R2InfrastructureSnapshot,
  type RailwayInfrastructureSnapshot,
  type RailwayUsageMeasurement,
} from "@/lib/infrastructureTypes";
import { railwayUsageMonitorEnabled } from "@/lib/railwayUsageMonitorFlag";

const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
const CLOUDFLARE_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const PRISMA_MANAGEMENT_API_URL = "https://api.prisma.io/v1";
const MAX_EXTERNAL_RESPONSE_BYTES = 1_000_000;
const EXTERNAL_TIMEOUT_MS = 8_000;
// One retry, not a loop. These are 15-minute-cadence billing-telemetry reads,
// so a second attempt costs nothing anybody is waiting on, while a third would
// only widen the window in which the maintenance route is blocked on a third
// party. Before this existed a single flaky second on Railway's or Prisma's
// usage endpoint raised a fatal INFRASTRUCTURE_*_ERROR incident.
const EXTERNAL_ATTEMPTS = 2;
const EXTERNAL_RETRY_DELAY_MS = 750;
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
// Railway reports its per-client usage-query concurrency limit as a GraphQL
// error at HTTP 200: "Too many usage queries are running at once. Please retry
// in 120 seconds. Limit: 16 concurrent usage queries per client." Matched on
// the two stable phrases rather than the whole sentence, which carries a
// changing retry window and limit.
const RAILWAY_USAGE_THROTTLE = /too many usage queries|concurrent usage quer/i;
const MINUTES_PER_30_DAY_MONTH = 30 * 24 * 60;
const RAILWAY_CPU_USD_PER_VCPU_MINUTE = 20 / MINUTES_PER_30_DAY_MONTH;
const RAILWAY_MEMORY_USD_PER_GB_MINUTE = 10 / MINUTES_PER_30_DAY_MONTH;
const RAILWAY_VOLUME_USD_PER_GB_MINUTE = 0.15 / MINUTES_PER_30_DAY_MONTH;
const RAILWAY_NETWORK_EGRESS_USD_PER_GB = 0.05;

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

/**
 * A usage read that did not land for a reason nobody can act on: the
 * third-party API timed out, refused the connection, answered 5xx, or
 * throttled us. It says nothing about Tomverse's own health -- only that this
 * one billing-telemetry read failed -- so the probe reports it as `warning`
 * (still an incident, at warning severity) instead of the `error` that pages
 * as fatal.
 *
 * Credential, permission, query and response-shape failures are deliberately
 * *not* transient: those stay `error`, because a person has to fix them.
 */
class TransientProbeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientProbeFailure";
  }
}

const transientStatus = (status: number) =>
  status === 408 || status === 425 || status === 429 || status >= 500;

// `fetch` rejects with TimeoutError for the AbortSignal budget above and with
// TypeError for DNS, TLS and socket failures. Neither says the configuration
// is wrong, only that this attempt did not complete.
const transientTransportError = (error: unknown) =>
  error instanceof Error &&
  (error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    error.name === "TypeError");

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The message the upstream itself supplied, for both shapes these probes meet:
 * Prisma's REST `{ error: { message } }` and the GraphQL `{ errors: [...] }`
 * Railway and Cloudflare answer with. Returns null when neither is present so
 * callers fall back to their own wording.
 */
const externalErrorMessage = (payload: unknown) => {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as {
    error?: { message?: unknown };
    errors?: Array<{ message?: unknown } | null>;
  };
  const message = record.error?.message ?? record.errors?.[0]?.message;
  return typeof message === "string" && message.trim()
    ? safeExternalMessage(message)
    : null;
};

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

/**
 * One usage read, retried once when the failure was transient. The response
 * is handed back unread-of-meaning: every probe still decides for itself what
 * a 4xx, a GraphQL `errors` array or a missing field means, because only the
 * probe knows which of those are actionable.
 */
const requestExternalJson = async (
  label: string,
  input: URL | string,
  init: RequestInit
): Promise<{ response: Response; payload: unknown }> => {
  let lastFailure: TransientProbeFailure | null = null;
  for (let attempt = 1; attempt <= EXTERNAL_ATTEMPTS; attempt += 1) {
    let rateLimited = false;
    try {
      const response = await fetch(input, {
        ...init,
        cache: "no-store",
        signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
      });
      if (!transientStatus(response.status)) {
        return { response, payload: await readBoundedJson(response) };
      }
      // Read separately from the success path: an error body is only wanted
      // for its message, so a malformed or oversized one is discarded rather
      // than replacing the status with a parse failure. `readBoundedJson`
      // still enforces the 1 MB ceiling before it throws.
      const failurePayload = await readBoundedJson(response).catch(() => null);
      rateLimited = response.status === 429;
      lastFailure = new TransientProbeFailure(
        externalErrorMessage(failurePayload) ||
          `${label} returned ${response.status}.`
      );
    } catch (error) {
      // Anything else -- a JSON syntax error, the 1 MB guard, a programming
      // fault -- is actionable and belongs to the caller unchanged.
      if (!transientTransportError(error)) throw error;
      lastFailure = new TransientProbeFailure(
        safeExternalMessage(error instanceof Error ? error.message : error)
      );
    }
    // A 429 states its own retry window in minutes -- Prisma's says 120
    // seconds -- so asking again inside this request only deepens the limit
    // it just reported.
    if (rateLimited || attempt === EXTERNAL_ATTEMPTS) break;
    await delay(EXTERNAL_RETRY_DELAY_MS);
  }
  throw lastFailure || new TransientProbeFailure(`${label} did not answer.`);
};

/**
 * The status and reason code a failed probe reports. Transient failures stay
 * off the fatal path: `planInfrastructureAlerts` turns a `warning` into an
 * `INFRASTRUCTURE_*_WARNING` incident, which still reaches Sentry, Slack and
 * email but does not claim the dependency is down.
 */
const probeFailure = (dependencyCode: string, error: unknown) => {
  const transient = error instanceof TransientProbeFailure;
  const message = safeExternalMessage(
    error instanceof Error ? error.message : error
  );
  return {
    status: (transient ? "warning" : "error") as "warning" | "error",
    message,
    warningReasons: [
      {
        code: transient
          ? `${dependencyCode}_USAGE_API_UNAVAILABLE`
          : `${dependencyCode}_API_ERROR`,
        detail: message,
      },
    ],
  };
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
    warningReasons: [] as RailwayInfrastructureSnapshot["warningReasons"],
    measurements: [] as RailwayUsageMeasurement[],
    apiRateLimit: { limit: null, remaining: null, resetAt: null },
    checkedAt,
  };

  // Checked before the credential check so an environment that deliberately
  // opted out is never reported as a missing-token misconfiguration, and
  // before any fetch so the `estimatedUsage` query is not issued at all.
  if (!railwayUsageMonitorEnabled()) {
    return {
      ...base,
      status: "disabled",
      message: RAILWAY_USAGE_MONITOR_DISABLED_MESSAGE,
      projectedMonthCostMicroUsd: null,
      projectedBalanceMicroUsd: null,
    };
  }

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
    const { response, payload: rawPayload } = await requestExternalJson(
      "Railway API",
      RAILWAY_GRAPHQL_URL,
      {
        method: "POST",
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
      }
    );
    const payload = (rawPayload || {}) as {
      data?: { estimatedUsage?: unknown };
      errors?: Array<{ message?: unknown }>;
    };
    // A GraphQL `errors` array or a 4xx is normally the query, the token or
    // the scope being wrong -- an operator has to change something -- so
    // unlike a 5xx or a timeout it is not retried and not downgraded.
    //
    // The one exception is Railway's own usage throttle, which arrives the
    // same way: HTTP 200 with the limit in `errors`. That is the limit
    // RAILWAY_USAGE_MONITOR_ENABLED exists for (two environments sharing one
    // Project-Access-Token), it carries its own retry window in minutes, and
    // it is not an outage -- so it reports as a warning and is never retried
    // inside this request.
    if (!response.ok || payload.errors?.length) {
      const message =
        externalErrorMessage(payload) ||
        `Railway API returned ${response.status}.`;
      throw RAILWAY_USAGE_THROTTLE.test(message)
        ? new TransientProbeFailure(message)
        : new Error(message);
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
        unit: "usage units",
        estimatedCostMicroUsd: null,
        projectId: typeof record.projectId === "string" ? record.projectId : null,
      }];
    });
    const values = new Map<string, number>();
    for (const measurement of measurements) {
      values.set(
        measurement.measurement,
        (values.get(measurement.measurement) || 0) +
          Math.max(0, measurement.estimatedValue)
      );
    }
    const cpuMeasurement = (values.get("CPU_USAGE_2") || 0) > 0
      ? "CPU_USAGE_2"
      : "CPU_USAGE";
    const pricedMeasurements = measurements.map((measurement) => {
      const value = Math.max(0, measurement.estimatedValue);
      if (measurement.measurement === cpuMeasurement) {
        return {
          ...measurement,
          unit: "vCPU-min",
          estimatedCostMicroUsd: Math.round(
            value * RAILWAY_CPU_USD_PER_VCPU_MINUTE * 1_000_000
          ),
        };
      }
      if (measurement.measurement === "MEMORY_USAGE_GB") {
        return {
          ...measurement,
          unit: "GB-min",
          estimatedCostMicroUsd: Math.round(
            value * RAILWAY_MEMORY_USD_PER_GB_MINUTE * 1_000_000
          ),
        };
      }
      if (measurement.measurement === "NETWORK_TX_GB") {
        return {
          ...measurement,
          unit: "GB egress",
          estimatedCostMicroUsd: Math.round(
            value * RAILWAY_NETWORK_EGRESS_USD_PER_GB * 1_000_000
          ),
        };
      }
      if (measurement.measurement === "NETWORK_RX_GB") {
        return { ...measurement, unit: "GB ingress" };
      }
      if (measurement.measurement === "DISK_USAGE_GB") {
        return {
          ...measurement,
          unit: "GB-min",
          estimatedCostMicroUsd: Math.round(
            value * RAILWAY_VOLUME_USD_PER_GB_MINUTE * 1_000_000
          ),
        };
      }
      if (
        measurement.measurement === "CPU_USAGE" ||
        measurement.measurement === "CPU_USAGE_2"
      ) {
        return { ...measurement, unit: "vCPU-min (alternate)" };
      }
      if (
        measurement.measurement.includes("DISK") ||
        measurement.measurement.includes("BACKUP")
      ) {
        return { ...measurement, unit: "GB-min" };
      }
      return measurement;
    });
    const projectedMonthCostMicroUsd = pricedMeasurements.reduce(
      (sum, measurement) => sum + (measurement.estimatedCostMicroUsd || 0),
      0
    );
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
      measurements: pricedMeasurements,
      warningReasons:
        configuredCreditMicroUsd === null
          ? [
              {
                code: "OPENING_CREDIT_NOT_CONFIGURED",
                detail:
                  "Usage synchronization succeeded, but no opening credit is saved, so projected balance cannot be calculated.",
              },
            ]
          : lowCredit
            ? [
                {
                  code: "PROJECTED_BALANCE_LOW",
                  detail:
                    "Projected remaining credit is negative or below 20% of the saved opening credit.",
                },
              ]
            : [],
      apiRateLimit: {
        limit: headerNumber(response.headers.get("x-ratelimit-limit")),
        remaining: headerNumber(response.headers.get("x-ratelimit-remaining")),
        resetAt: response.headers.get("x-ratelimit-reset"),
      },
    };
  } catch (error) {
    return {
      ...base,
      ...probeFailure("RAILWAY", error),
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
    const { response, payload: rawPayload } = await requestExternalJson(
      "Prisma Management API",
      url,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );
    const payload = (rawPayload || {}) as {
      period?: { start?: unknown; end?: unknown };
      metrics?: {
        operations?: { used?: unknown };
        storage?: { used?: unknown };
      };
      error?: { message?: unknown };
    };
    // Only 4xx reaches here: the retryable statuses never return from
    // `requestExternalJson`. A rejected token or an unknown database id is
    // somebody's job to fix, so it keeps reporting as an error.
    if (!response.ok) {
      throw new Error(
        externalErrorMessage(payload) ||
          `Prisma Management API returned ${response.status}.`
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
    return { ...base, ...probeFailure("PRISMA", error) };
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
    const { response, payload: rawPayload } = await requestExternalJson(
      "Cloudflare API",
      CLOUDFLARE_GRAPHQL_URL,
      {
        method: "POST",
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
      }
    );
    const payload = (rawPayload || {}) as {
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
    // Same split as Railway: a GraphQL `errors` array or a 4xx is the token,
    // the account tag or the query, none of which a retry fixes.
    if (!response.ok || payload.errors?.length) {
      throw new Error(
        externalErrorMessage(payload) ||
          `Cloudflare API returned ${response.status}.`
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
    return { ...base, ...probeFailure("R2", error) };
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
