import "server-only";

import type { AiProvider } from "@/lib/models";
import { recordProviderReportedUsage } from "@/lib/providerUsageAccounting";
import {
  MONITORED_PROVIDERS,
  PROVIDER_API_KEY_ENV,
  PROVIDER_DISPLAY_NAMES,
} from "@/lib/providerMonitoring";
import {
  openAiCostsUrl,
  parseOpenAiCostsPage,
  redactProviderDiagnostic,
} from "@/lib/providerUsageSyncCore";

export type ProviderUsageSyncStatus = "synced" | "skipped" | "failed";

export type ProviderUsageSyncDiagnostic = {
  traceId: string;
  source: "openai_costs" | "generic_usage";
  endpoint: string;
  httpStatus: number | null;
  errorType: string | null;
  errorCode: string | null;
  providerRequestId: string | null;
  detail: string | null;
};

export type ProviderUsageSyncResult = {
  provider: AiProvider;
  displayName: string;
  status: ProviderUsageSyncStatus;
  reportedCostMicroUsd: number | null;
  message: string;
  diagnostic: ProviderUsageSyncDiagnostic | null;
};

const OPENAI_COSTS_URL = "https://api.openai.com/v1/organization/costs";
const EXTERNAL_TIMEOUT_MS = 10_000;
const MAX_EXTERNAL_RESPONSE_BYTES = 512_000;
const MAX_OPENAI_PAGES = 10;

const envProvider = (provider: AiProvider) => provider.toUpperCase();

const dayStartUtc = (date = new Date()) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

export const defaultProviderUsageSyncDate = () => {
  const now = new Date();
  return dayStartUtc(new Date(now.getTime() - 86_400_000));
};

const valueAtPath = (data: unknown, path: string) => {
  const parts = path.split(".").filter(Boolean);
  let value = data;
  for (const part of parts) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
};

const numericValueAtPath = (data: unknown, path: string) => {
  const value = valueAtPath(data, path);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const configuredApiKey = (provider: AiProvider) =>
  PROVIDER_API_KEY_ENV[provider].map((key) => process.env[key]).find(Boolean);

const usageUrlFor = (provider: AiProvider, date: Date) => {
  const key = envProvider(provider);
  const url = process.env[`PROVIDER_${key}_USAGE_URL`];
  if (!url) return null;
  const dateText = date.toISOString().slice(0, 10);
  return url.replaceAll("{date}", dateText);
};

const usageAuthHeaderFor = (provider: AiProvider) => {
  const key = envProvider(provider);
  const apiKey = configuredApiKey(provider);
  return (
    process.env[`PROVIDER_${key}_USAGE_AUTH_HEADER`] ||
    (apiKey ? `Bearer ${apiKey}` : undefined)
  );
};

const endpointLabel = (value: string) => {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`.slice(0, 200);
  } catch {
    return "invalid usage endpoint";
  }
};

const headerNumber = (value: string | null) => {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const readBoundedJson = async (response: Response) => {
  const declaredLength = headerNumber(response.headers.get("content-length"));
  if (declaredLength !== null && declaredLength > MAX_EXTERNAL_RESPONSE_BYTES) {
    throw new Error("Usage API response exceeded the 512 KB safety limit.");
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
      throw new Error("Usage API response exceeded the 512 KB safety limit.");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  if (!text.trim()) return null;
  return JSON.parse(text) as unknown;
};

const diagnosticValue = (payload: unknown, field: string) => {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return null;
  return redactProviderDiagnostic((error as Record<string, unknown>)[field], 160);
};

const failedResult = ({
  provider,
  date,
  message,
  diagnostic,
  cause,
}: {
  provider: AiProvider;
  date: Date;
  message: string;
  diagnostic: ProviderUsageSyncDiagnostic;
  cause?: unknown;
}): ProviderUsageSyncResult => {
  const safeMessage = redactProviderDiagnostic(message) || "Usage sync failed.";
  const log = {
    event: "provider_usage_sync_failed",
    provider,
    date: date.toISOString().slice(0, 10),
    traceId: diagnostic.traceId,
    source: diagnostic.source,
    endpoint: diagnostic.endpoint,
    httpStatus: diagnostic.httpStatus,
    errorType: diagnostic.errorType,
    errorCode: diagnostic.errorCode,
    providerRequestId: diagnostic.providerRequestId,
    detail: diagnostic.detail,
    cause:
      cause instanceof Error
        ? redactProviderDiagnostic(cause.message)
        : null,
  };
  console.warn("Provider usage sync failed", log);
  return {
    provider,
    displayName: PROVIDER_DISPLAY_NAMES[provider],
    status: "failed",
    reportedCostMicroUsd: null,
    message: safeMessage,
    diagnostic,
  };
};

const syncOpenAiCosts = async (date: Date): Promise<ProviderUsageSyncResult> => {
  const provider: AiProvider = "openai";
  const displayName = PROVIDER_DISPLAY_NAMES[provider];
  const adminKey = process.env.OPENAI_ADMIN_API_KEY?.trim();
  if (!adminKey) {
    return {
      provider,
      displayName,
      status: "skipped",
      reportedCostMicroUsd: null,
      message: "OPENAI_ADMIN_API_KEY is not configured.",
      diagnostic: null,
    };
  }

  const traceId = crypto.randomUUID();
  let page: string | null = null;
  let pageCount = 0;
  let costUsd = 0;
  const providerRequestIds: string[] = [];

  try {
    do {
      pageCount += 1;
      if (pageCount > MAX_OPENAI_PAGES) {
        throw new Error("OpenAI Costs API pagination exceeded the safety limit.");
      }
      const url = openAiCostsUrl({ baseUrl: OPENAI_COSTS_URL, date, page });
      const response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${adminKey}`,
          "Content-Type": "application/json",
        },
      });
      const requestId = redactProviderDiagnostic(
        response.headers.get("x-request-id"),
        160
      );
      if (requestId) providerRequestIds.push(requestId);
      const payload = await readBoundedJson(response);
      if (!response.ok) {
        const errorCode = diagnosticValue(payload, "code");
        const errorType = diagnosticValue(payload, "type");
        const detail = diagnosticValue(payload, "message");
        const message =
          response.status === 401 || response.status === 403
            ? `OpenAI Costs API denied access (${response.status}). Verify that OPENAI_ADMIN_API_KEY was created by an Organization Owner.`
            : `OpenAI Costs API returned ${response.status}.`;
        return failedResult({
          provider,
          date,
          message,
          diagnostic: {
            traceId,
            source: "openai_costs",
            endpoint: endpointLabel(OPENAI_COSTS_URL),
            httpStatus: response.status,
            errorType,
            errorCode,
            providerRequestId: requestId,
            detail,
          },
        });
      }

      const parsed = parseOpenAiCostsPage(payload);
      costUsd += parsed.costUsd;
      if (parsed.hasMore && !parsed.nextPage) {
        throw new Error("OpenAI Costs API omitted the next page cursor.");
      }
      page = parsed.hasMore ? parsed.nextPage : null;
    } while (page);

    const reportedCostMicroUsd = Math.round(costUsd * 1_000_000);
    await recordProviderReportedUsage({
      provider,
      date,
      costMicroUsd: reportedCostMicroUsd,
      payload: {
        source: "openai_costs",
        date: date.toISOString().slice(0, 10),
        costUsd,
        pageCount,
        providerRequestIds,
      },
    });
    return {
      provider,
      displayName,
      status: "synced",
      reportedCostMicroUsd,
      message: "OpenAI organization costs were reconciled.",
      diagnostic: null,
    };
  } catch (error) {
    const isTimeout =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    return failedResult({
      provider,
      date,
      message: isTimeout
        ? "OpenAI Costs API timed out after 10 seconds."
        : "OpenAI Costs API response could not be reconciled.",
      diagnostic: {
        traceId,
        source: "openai_costs",
        endpoint: endpointLabel(OPENAI_COSTS_URL),
        httpStatus: null,
        errorType: isTimeout ? "timeout" : error instanceof Error ? error.name : null,
        errorCode: isTimeout ? "OPENAI_COSTS_TIMEOUT" : "OPENAI_COSTS_SYNC_FAILED",
        providerRequestId: providerRequestIds.at(-1) || null,
        detail:
          error instanceof Error
            ? redactProviderDiagnostic(error.message)
            : "OpenAI Costs API request failed.",
      },
      cause: error,
    });
  }
};

const syncGenericUsage = async (
  provider: AiProvider,
  date: Date
): Promise<ProviderUsageSyncResult> => {
  const displayName = PROVIDER_DISPLAY_NAMES[provider];
  const url = usageUrlFor(provider, date);
  const jsonPath =
    process.env[`PROVIDER_${envProvider(provider)}_USAGE_COST_JSON_PATH`];

  if (!url || !jsonPath) {
    return {
      provider,
      displayName,
      status: "skipped",
      reportedCostMicroUsd: null,
      message: "Usage URL or cost JSON path is not configured.",
      diagnostic: null,
    };
  }

  const traceId = crypto.randomUUID();
  try {
    const authHeader = usageAuthHeaderFor(provider);
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
    });
    const payload = await readBoundedJson(response);
    const providerRequestId = redactProviderDiagnostic(
      response.headers.get("x-request-id") || response.headers.get("request-id"),
      160
    );
    if (!response.ok) {
      return failedResult({
        provider,
        date,
        message: `Usage API returned ${response.status}.`,
        diagnostic: {
          traceId,
          source: "generic_usage",
          endpoint: endpointLabel(url),
          httpStatus: response.status,
          errorType: diagnosticValue(payload, "type"),
          errorCode: diagnosticValue(payload, "code"),
          providerRequestId,
          detail: diagnosticValue(payload, "message"),
        },
      });
    }

    const costUsd = numericValueAtPath(payload, jsonPath);
    if (costUsd === null || costUsd < 0) {
      return failedResult({
        provider,
        date,
        message: `Could not read a numeric USD cost at ${jsonPath}.`,
        diagnostic: {
          traceId,
          source: "generic_usage",
          endpoint: endpointLabel(url),
          httpStatus: response.status,
          errorType: "payload_validation",
          errorCode: "USAGE_COST_PATH_INVALID",
          providerRequestId,
          detail: "The configured JSON path did not resolve to a non-negative number.",
        },
      });
    }

    const reportedCostMicroUsd = Math.round(costUsd * 1_000_000);
    await recordProviderReportedUsage({
      provider,
      date,
      costMicroUsd: reportedCostMicroUsd,
      payload,
    });
    return {
      provider,
      displayName,
      status: "synced",
      reportedCostMicroUsd,
      message: "Provider usage was reconciled.",
      diagnostic: null,
    };
  } catch (error) {
    const isTimeout =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    return failedResult({
      provider,
      date,
      message: isTimeout
        ? "Usage API timed out after 10 seconds."
        : "Usage API request failed.",
      diagnostic: {
        traceId,
        source: "generic_usage",
        endpoint: endpointLabel(url),
        httpStatus: null,
        errorType: isTimeout ? "timeout" : error instanceof Error ? error.name : null,
        errorCode: isTimeout ? "USAGE_API_TIMEOUT" : "USAGE_API_REQUEST_FAILED",
        providerRequestId: null,
        detail:
          error instanceof Error
            ? redactProviderDiagnostic(error.message)
            : "Usage API request failed.",
      },
      cause: error,
    });
  }
};

export async function syncProviderUsageForDate(
  requestedDate = defaultProviderUsageSyncDate()
): Promise<ProviderUsageSyncResult[]> {
  const date = dayStartUtc(requestedDate);
  const results: ProviderUsageSyncResult[] = [];

  for (const provider of MONITORED_PROVIDERS) {
    results.push(
      provider === "openai"
        ? await syncOpenAiCosts(date)
        : await syncGenericUsage(provider, date)
    );
  }

  return results;
}
