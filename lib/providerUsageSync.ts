import "server-only";

import type { AiProvider } from "@/lib/models";
import {
  getInternalProviderUsageSummary,
  recordProviderReportedUsage,
} from "@/lib/providerUsageAccounting";
import {
  MONITORED_PROVIDERS,
  PROVIDER_API_KEY_ENV,
  PROVIDER_DISPLAY_NAMES,
} from "@/lib/providerMonitoring";
import {
  anthropicCostsUrl,
  AnthropicCostsParseError,
  isRetryableOpenAiStatus,
  OpenAiCostsParseError,
  openAiCostsRequestPolicy,
  openAiCostsRetryDelayMs,
  openAiCostsUrl,
  parseAnthropicCostsPage,
  parseOpenAiCostsPage,
  parseXaiUsage,
  redactProviderDiagnostic,
  XaiUsageParseError,
  xaiUsageDayRequest,
  xaiUsageUrl,
} from "@/lib/providerUsageSyncCore";

export type ProviderUsageSyncStatus =
  | "synced"
  | "internal"
  | "skipped"
  | "failed";

export type ProviderUsageSyncFailureStage =
  | "connection"
  | "response"
  | "provider_http"
  | "payload"
  | "storage";

export type ProviderUsageSyncDiagnostic = {
  traceId: string;
  source:
    | "openai_costs"
    | "anthropic_costs"
    | "xai_usage"
    | "generic_usage";
  endpoint: string;
  httpStatus: number | null;
  errorType: string | null;
  errorCode: string | null;
  providerRequestId: string | null;
  detail: string | null;
  attemptCount?: number;
  attemptTimeoutMs?: number;
  elapsedMs?: number;
  failureStage?: ProviderUsageSyncFailureStage;
};

export type ProviderUsageSyncResult = {
  provider: AiProvider;
  displayName: string;
  status: ProviderUsageSyncStatus;
  reportedCostMicroUsd: number | null;
  internalCostMicroUsd?: number;
  internalUsage?: {
    requestCount: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
  usageSourceLabel?: string;
  reconciliationLabel?: string;
  message: string;
  diagnostic: ProviderUsageSyncDiagnostic | null;
};

const OPENAI_COSTS_URL = "https://api.openai.com/v1/organization/costs";
const ANTHROPIC_COSTS_URL =
  "https://api.anthropic.com/v1/organizations/cost_report";
const XAI_USAGE_BASE_URL =
  "https://management-api.x.ai/v1/billing/teams";
const GENERIC_EXTERNAL_TIMEOUT_MS = 10_000;
const MAX_EXTERNAL_RESPONSE_BYTES = 512_000;
const MAX_OPENAI_PAGES = 10;
const MAX_ANTHROPIC_PAGES = 10;

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

const isTimeoutError = (error: unknown) =>
  error instanceof Error &&
  (error.name === "TimeoutError" || error.name === "AbortError");

const isRetryableNetworkError = (error: unknown) =>
  isTimeoutError(error) || error instanceof TypeError;

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

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
    attemptCount: diagnostic.attemptCount,
    attemptTimeoutMs: diagnostic.attemptTimeoutMs,
    elapsedMs: diagnostic.elapsedMs,
    failureStage: diagnostic.failureStage,
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

  const requestPolicy = openAiCostsRequestPolicy({
    timeoutMs: process.env.OPENAI_COSTS_TIMEOUT_MS,
    maxAttempts: process.env.OPENAI_COSTS_MAX_ATTEMPTS,
  });
  const traceId = crypto.randomUUID();
  const syncStartedAt = Date.now();
  let page: string | null = null;
  let pageCount = 0;
  let costUsd = 0;
  let lineItemCount = 0;
  let negativeLineItemCount = 0;
  let normalizedStringAmountCount = 0;
  let attemptCount = 0;
  let lastHttpStatus: number | null = null;
  let lastProviderRequestId: string | null = null;
  let failureStage: ProviderUsageSyncFailureStage = "connection";
  const providerRequestIds: string[] = [];

  try {
    do {
      pageCount += 1;
      if (pageCount > MAX_OPENAI_PAGES) {
        throw new Error("OpenAI Costs API pagination exceeded the safety limit.");
      }
      const url = openAiCostsUrl({ baseUrl: OPENAI_COSTS_URL, date, page });
      let pageCompleted = false;

      for (
        let pageAttempt = 1;
        pageAttempt <= requestPolicy.maxAttempts;
        pageAttempt += 1
      ) {
        attemptCount += 1;
        lastHttpStatus = null;
        lastProviderRequestId = null;
        failureStage = "connection";

        try {
          const response = await fetch(url, {
            cache: "no-store",
            signal: AbortSignal.timeout(requestPolicy.attemptTimeoutMs),
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${adminKey}`,
            },
          });
          lastHttpStatus = response.status;
          const requestId = redactProviderDiagnostic(
            response.headers.get("x-request-id"),
            160
          );
          lastProviderRequestId = requestId;
          if (requestId) providerRequestIds.push(requestId);
          failureStage = "response";
          const payload = await readBoundedJson(response);

          if (!response.ok) {
            failureStage = "provider_http";
            if (
              isRetryableOpenAiStatus(response.status) &&
              pageAttempt < requestPolicy.maxAttempts
            ) {
              await wait(
                openAiCostsRetryDelayMs({
                  attempt: pageAttempt,
                  retryAfter: response.headers.get("retry-after"),
                  retryAfterMs: response.headers.get("retry-after-ms"),
                })
              );
              continue;
            }

            const errorCode = diagnosticValue(payload, "code");
            const errorType = diagnosticValue(payload, "type");
            const detail = diagnosticValue(payload, "message");
            const message =
              response.status === 401 || response.status === 403
                ? `OpenAI Costs API denied access (${response.status}). Verify that OPENAI_ADMIN_API_KEY was created by an Organization Owner.`
                : `OpenAI Costs API returned ${response.status} after ${pageAttempt} attempt${pageAttempt === 1 ? "" : "s"}.`;
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
                errorCode: errorCode || `OPENAI_COSTS_HTTP_${response.status}`,
                providerRequestId: requestId,
                detail,
                attemptCount,
                attemptTimeoutMs: requestPolicy.attemptTimeoutMs,
                elapsedMs: Date.now() - syncStartedAt,
                failureStage,
              },
            });
          }

          failureStage = "payload";
          const parsed = parseOpenAiCostsPage(payload);
          costUsd += parsed.costUsd;
          lineItemCount += parsed.lineItemCount;
          negativeLineItemCount += parsed.negativeLineItemCount;
          normalizedStringAmountCount += parsed.normalizedStringAmountCount;
          if (parsed.hasMore && !parsed.nextPage) {
            throw new Error("OpenAI Costs API omitted the next page cursor.");
          }
          page = parsed.hasMore ? parsed.nextPage : null;
          pageCompleted = true;
          break;
        } catch (error) {
          if (
            isRetryableNetworkError(error) &&
            pageAttempt < requestPolicy.maxAttempts
          ) {
            await wait(openAiCostsRetryDelayMs({ attempt: pageAttempt }));
            continue;
          }
          throw error;
        }
      }

      if (!pageCompleted) {
        throw new Error("OpenAI Costs API retry policy ended unexpectedly.");
      }
    } while (page);

    const reportedCostMicroUsd = Math.round(costUsd * 1_000_000);
    failureStage = "storage";
    await recordProviderReportedUsage({
      provider,
      date,
      costMicroUsd: reportedCostMicroUsd,
      payload: {
        source: "openai_costs",
        date: date.toISOString().slice(0, 10),
        costUsd,
        pageCount,
        lineItemCount,
        negativeLineItemCount,
        normalizedStringAmountCount,
        providerRequestIds,
        requestAttemptCount: attemptCount,
        requestAttemptTimeoutMs: requestPolicy.attemptTimeoutMs,
      },
    });
    return {
      provider,
      displayName,
      status: "synced",
      reportedCostMicroUsd,
      message:
        negativeLineItemCount > 0
          ? "OpenAI net organization costs were reconciled, including credits or adjustments."
          : "OpenAI organization costs were reconciled.",
      diagnostic: null,
    };
  } catch (error) {
    const isTimeout = isTimeoutError(error);
    const isNetworkError = !isTimeout && error instanceof TypeError;
    const noHttpResponse = lastHttpStatus === null && failureStage === "connection";
    return failedResult({
      provider,
      date,
      message: isTimeout
        ? noHttpResponse
          ? `No HTTP response was received from OpenAI after ${requestPolicy.maxAttempts} attempts (${requestPolicy.attemptTimeoutMs / 1_000}s each).`
          : `OpenAI Costs API response timed out after ${requestPolicy.maxAttempts} attempts (${requestPolicy.attemptTimeoutMs / 1_000}s each).`
        : isNetworkError
          ? `OpenAI Costs API network request failed after ${requestPolicy.maxAttempts} attempts.`
        : "OpenAI Costs API response could not be reconciled.",
      diagnostic: {
        traceId,
        source: "openai_costs",
        endpoint: endpointLabel(OPENAI_COSTS_URL),
        httpStatus: lastHttpStatus,
        errorType: isTimeout ? "timeout" : error instanceof Error ? error.name : null,
        errorCode: isTimeout
          ? noHttpResponse
            ? "OPENAI_COSTS_CONNECT_TIMEOUT"
            : "OPENAI_COSTS_RESPONSE_TIMEOUT"
          : isNetworkError
            ? "OPENAI_COSTS_NETWORK_ERROR"
          : error instanceof OpenAiCostsParseError
            ? error.code
            : "OPENAI_COSTS_SYNC_FAILED",
        providerRequestId: lastProviderRequestId,
        detail:
          isTimeout && noHttpResponse
            ? "Tomverse received no response headers, so authentication and API permissions could not yet be evaluated."
            : error instanceof Error
              ? redactProviderDiagnostic(error.message)
              : "OpenAI Costs API request failed.",
        attemptCount,
        attemptTimeoutMs: requestPolicy.attemptTimeoutMs,
        elapsedMs: Date.now() - syncStartedAt,
        failureStage,
      },
      cause: error,
    });
  }
};

const syncAnthropicCosts = async (
  date: Date
): Promise<ProviderUsageSyncResult> => {
  const provider: AiProvider = "anthropic";
  const displayName = PROVIDER_DISPLAY_NAMES[provider];
  const adminKey = process.env.ANTHROPIC_ADMIN_API_KEY?.trim();
  if (!adminKey) {
    return {
      provider,
      displayName,
      status: "skipped",
      reportedCostMicroUsd: null,
      message: "ANTHROPIC_ADMIN_API_KEY is not configured.",
      diagnostic: null,
    };
  }

  const traceId = crypto.randomUUID();
  let page: string | null = null;
  let pageCount = 0;
  let reportedCostMicroUsd = 0;
  let lineItemCount = 0;
  let lastHttpStatus: number | null = null;
  let lastProviderRequestId: string | null = null;
  let failureStage: ProviderUsageSyncFailureStage = "connection";
  const providerRequestIds: string[] = [];

  try {
    do {
      pageCount += 1;
      if (pageCount > MAX_ANTHROPIC_PAGES) {
        throw new Error("Anthropic Cost API pagination exceeded the safety limit.");
      }
      const url = anthropicCostsUrl({
        baseUrl: ANTHROPIC_COSTS_URL,
        date,
        page,
      });
      failureStage = "connection";
      lastHttpStatus = null;
      lastProviderRequestId = null;
      const response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(GENERIC_EXTERNAL_TIMEOUT_MS),
        headers: {
          Accept: "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": adminKey,
        },
      });
      lastHttpStatus = response.status;
      const requestId = redactProviderDiagnostic(
        response.headers.get("request-id") || response.headers.get("x-request-id"),
        160
      );
      lastProviderRequestId = requestId;
      if (requestId) providerRequestIds.push(requestId);
      failureStage = "response";
      const payload = await readBoundedJson(response);

      if (!response.ok) {
        failureStage = "provider_http";
        const message =
          response.status === 401 || response.status === 403
            ? `Anthropic Cost API denied access (${response.status}). Verify that ANTHROPIC_ADMIN_API_KEY is an Admin API key for a Claude Console organization.`
            : `Anthropic Cost API returned ${response.status}.`;
        return failedResult({
          provider,
          date,
          message,
          diagnostic: {
            traceId,
            source: "anthropic_costs",
            endpoint: endpointLabel(ANTHROPIC_COSTS_URL),
            httpStatus: response.status,
            errorType: diagnosticValue(payload, "type"),
            errorCode:
              diagnosticValue(payload, "code") ||
              `ANTHROPIC_COSTS_HTTP_${response.status}`,
            providerRequestId: requestId,
            detail: diagnosticValue(payload, "message"),
            attemptCount: pageCount,
            attemptTimeoutMs: GENERIC_EXTERNAL_TIMEOUT_MS,
            failureStage,
          },
        });
      }

      failureStage = "payload";
      const parsed = parseAnthropicCostsPage(payload);
      reportedCostMicroUsd += parsed.costMicroUsd;
      lineItemCount += parsed.lineItemCount;
      if (parsed.hasMore && !parsed.nextPage) {
        throw new Error("Anthropic Cost API omitted the next page cursor.");
      }
      page = parsed.hasMore ? parsed.nextPage : null;
    } while (page);

    failureStage = "storage";
    await recordProviderReportedUsage({
      provider,
      date,
      costMicroUsd: reportedCostMicroUsd,
      payload: {
        source: "anthropic_costs",
        date: date.toISOString().slice(0, 10),
        costMicroUsd: reportedCostMicroUsd,
        pageCount,
        lineItemCount,
        providerRequestIds,
      },
    });
    return {
      provider,
      displayName,
      status: "synced",
      reportedCostMicroUsd,
      message: "Anthropic organization costs were reconciled.",
      diagnostic: null,
    };
  } catch (error) {
    const isTimeout = isTimeoutError(error);
    return failedResult({
      provider,
      date,
      message: isTimeout
        ? "Anthropic Cost API timed out after 10 seconds."
        : "Anthropic Cost API response could not be reconciled.",
      diagnostic: {
        traceId,
        source: "anthropic_costs",
        endpoint: endpointLabel(ANTHROPIC_COSTS_URL),
        httpStatus: lastHttpStatus,
        errorType: isTimeout ? "timeout" : error instanceof Error ? error.name : null,
        errorCode: isTimeout
          ? "ANTHROPIC_COSTS_TIMEOUT"
          : error instanceof AnthropicCostsParseError
            ? error.code
            : "ANTHROPIC_COSTS_SYNC_FAILED",
        providerRequestId: lastProviderRequestId,
        detail:
          error instanceof Error
            ? redactProviderDiagnostic(error.message)
            : "Anthropic Cost API request failed.",
        attemptCount: pageCount,
        attemptTimeoutMs: GENERIC_EXTERNAL_TIMEOUT_MS,
        failureStage,
      },
      cause: error,
    });
  }
};

const syncXaiUsage = async (
  date: Date
): Promise<ProviderUsageSyncResult> => {
  const provider: AiProvider = "xai";
  const displayName = PROVIDER_DISPLAY_NAMES[provider];
  const managementKey = process.env.XAI_MANAGEMENT_API_KEY?.trim();
  const teamId = process.env.XAI_TEAM_ID?.trim();
  if (!managementKey || !teamId) {
    const missing = [
      !managementKey ? "XAI_MANAGEMENT_API_KEY" : null,
      !teamId ? "XAI_TEAM_ID" : null,
    ].filter(Boolean);
    return {
      provider,
      displayName,
      status: "skipped",
      reportedCostMicroUsd: null,
      message: `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not configured.`,
      diagnostic: null,
    };
  }

  const url = xaiUsageUrl({ baseUrl: XAI_USAGE_BASE_URL, teamId });
  const traceId = crypto.randomUUID();
  let lastHttpStatus: number | null = null;
  let lastProviderRequestId: string | null = null;
  let failureStage: ProviderUsageSyncFailureStage = "connection";
  try {
    const response = await fetch(url, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(GENERIC_EXTERNAL_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${managementKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(xaiUsageDayRequest(date)),
    });
    lastHttpStatus = response.status;
    lastProviderRequestId = redactProviderDiagnostic(
      response.headers.get("x-request-id") || response.headers.get("request-id"),
      160
    );
    failureStage = "response";
    const payload = await readBoundedJson(response);

    if (!response.ok) {
      failureStage = "provider_http";
      const message =
        response.status === 401 || response.status === 403
          ? `xAI Management Usage API denied access (${response.status}). Verify the Management Key permission and Team ID.`
          : response.status === 404
            ? "xAI Management Usage API could not find the configured team. Verify XAI_TEAM_ID."
            : `xAI Management Usage API returned ${response.status}.`;
      return failedResult({
        provider,
        date,
        message,
        diagnostic: {
          traceId,
          source: "xai_usage",
          endpoint: endpointLabel(url),
          httpStatus: response.status,
          errorType: diagnosticValue(payload, "type"),
          errorCode:
            diagnosticValue(payload, "code") ||
            `XAI_USAGE_HTTP_${response.status}`,
          providerRequestId: lastProviderRequestId,
          detail: diagnosticValue(payload, "message"),
          attemptCount: 1,
          attemptTimeoutMs: GENERIC_EXTERNAL_TIMEOUT_MS,
          failureStage,
        },
      });
    }

    failureStage = "payload";
    const parsed = parseXaiUsage(payload);
    const reportedCostMicroUsd = Math.round(parsed.costUsd * 1_000_000);
    failureStage = "storage";
    await recordProviderReportedUsage({
      provider,
      date,
      costMicroUsd: reportedCostMicroUsd,
      payload: {
        source: "xai_usage",
        date: date.toISOString().slice(0, 10),
        costUsd: parsed.costUsd,
        seriesCount: parsed.seriesCount,
        dataPointCount: parsed.dataPointCount,
        providerRequestId: lastProviderRequestId,
      },
    });
    return {
      provider,
      displayName,
      status: "synced",
      reportedCostMicroUsd,
      message: "xAI team usage costs were reconciled.",
      diagnostic: null,
    };
  } catch (error) {
    const isTimeout = isTimeoutError(error);
    return failedResult({
      provider,
      date,
      message: isTimeout
        ? "xAI Management Usage API timed out after 10 seconds."
        : "xAI Management Usage API response could not be reconciled.",
      diagnostic: {
        traceId,
        source: "xai_usage",
        endpoint: endpointLabel(url),
        httpStatus: lastHttpStatus,
        errorType: isTimeout
          ? "timeout"
          : error instanceof Error
            ? error.name
            : null,
        errorCode: isTimeout
          ? "XAI_USAGE_TIMEOUT"
          : error instanceof XaiUsageParseError
            ? error.code
            : "XAI_USAGE_SYNC_FAILED",
        providerRequestId: lastProviderRequestId,
        detail:
          error instanceof Error
            ? redactProviderDiagnostic(error.message)
            : "xAI Management Usage API request failed.",
        attemptCount: 1,
        attemptTimeoutMs: GENERIC_EXTERNAL_TIMEOUT_MS,
        failureStage,
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
      signal: AbortSignal.timeout(GENERIC_EXTERNAL_TIMEOUT_MS),
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
    const isTimeout = isTimeoutError(error);
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

const mistralInternalUsage = async (
  date: Date
): Promise<ProviderUsageSyncResult> => {
  const provider: AiProvider = "mistral";
  const usage = await getInternalProviderUsageSummary({ provider, date });
  return {
    provider,
    displayName: PROVIDER_DISPLAY_NAMES[provider],
    status: "internal",
    reportedCostMicroUsd: null,
    internalCostMicroUsd: usage.estimatedCostMicroUsd,
    internalUsage: {
      requestCount: usage.requestCount,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
    },
    usageSourceLabel: "Internal response accounting",
    reconciliationLabel: "Unavailable on current Mistral plan",
    message:
      "Response Usage is costed with the request-time model price snapshot. Verify the monthly total manually in the Mistral Usage dashboard.",
    diagnostic: null,
  };
};

export async function syncProviderUsageForDate(
  requestedDate = defaultProviderUsageSyncDate()
): Promise<ProviderUsageSyncResult[]> {
  const date = dayStartUtc(requestedDate);
  const results: ProviderUsageSyncResult[] = [];

  for (const provider of MONITORED_PROVIDERS) {
    const hasGenericMistralUsageEndpoint =
      provider === "mistral" &&
      Boolean(usageUrlFor(provider, date)) &&
      Boolean(
        process.env[`PROVIDER_${envProvider(provider)}_USAGE_COST_JSON_PATH`]
      );
    results.push(
      provider === "openai"
        ? await syncOpenAiCosts(date)
        : provider === "anthropic"
          ? await syncAnthropicCosts(date)
          : provider === "xai"
            ? await syncXaiUsage(date)
            : provider === "mistral" && !hasGenericMistralUsageEndpoint
              ? await mistralInternalUsage(date)
              : await syncGenericUsage(provider, date)
    );
  }

  return results;
}
