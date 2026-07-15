import "server-only";

import { sign as signJwt } from "node:crypto";
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
import {
  CloudBillingParseError,
  createAlibabaCloudBillingRequest,
  googleCloudBillingQueryRequest,
  parseAlibabaCloudBillingPage,
  parseGoogleCloudBillingQuery,
  validateGoogleBillingExportTable,
} from "@/lib/cloudBillingSyncCore";

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
    | "google_cloud_billing"
    | "alibaba_cloud_billing"
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
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_BIGQUERY_API = "https://bigquery.googleapis.com/bigquery/v2";
const ALIBABA_BILLING_DEFAULT_ENDPOINT =
  "https://business.ap-southeast-1.aliyuncs.com";
const GENERIC_EXTERNAL_TIMEOUT_MS = 10_000;
const MAX_EXTERNAL_RESPONSE_BYTES = 512_000;
const MAX_OPENAI_PAGES = 10;
const MAX_ANTHROPIC_PAGES = 10;
const MAX_ALIBABA_BILLING_PAGES = 167;

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
  const record = payload as Record<string, unknown>;
  const error = record.error;
  const value =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)[field]
      : record[field] ?? record[field[0]?.toUpperCase() + field.slice(1)];
  return redactProviderDiagnostic(value, 160);
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

type GoogleServiceAccount = {
  project_id?: string;
  client_email: string;
  private_key: string;
};

const base64Url = (value: string | Uint8Array) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const googleServiceAccount = (): GoogleServiceAccount | null => {
  const json = process.env.GOOGLE_CLOUD_BILLING_SERVICE_ACCOUNT_JSON?.trim();
  const base64 =
    process.env.GOOGLE_CLOUD_BILLING_SERVICE_ACCOUNT_JSON_BASE64?.trim();
  if (!json && !base64) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      json || Buffer.from(base64!, "base64").toString("utf8")
    );
  } catch {
    throw new CloudBillingParseError(
      "GOOGLE_BILLING_CREDENTIALS_INVALID",
      "Google Cloud Billing service-account JSON is invalid."
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new CloudBillingParseError(
      "GOOGLE_BILLING_CREDENTIALS_INVALID",
      "Google Cloud Billing service-account JSON is invalid."
    );
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.client_email !== "string" ||
    !record.client_email.trim() ||
    typeof record.private_key !== "string" ||
    !record.private_key.includes("PRIVATE KEY")
  ) {
    throw new CloudBillingParseError(
      "GOOGLE_BILLING_CREDENTIALS_INVALID",
      "Google Cloud Billing service-account JSON omitted client_email or private_key."
    );
  }
  return {
    project_id:
      typeof record.project_id === "string" ? record.project_id.trim() : undefined,
    client_email: record.client_email.trim(),
    private_key: record.private_key,
  };
};

const googleAccessToken = async (account: GoogleServiceAccount) => {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const header = base64Url(
    JSON.stringify({ alg: "RS256", typ: "JWT" })
  );
  const claims = base64Url(
    JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: GOOGLE_OAUTH_TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3_600,
    })
  );
  const unsigned = `${header}.${claims}`;
  const signature = signJwt(
    "RSA-SHA256",
    Buffer.from(unsigned, "utf8"),
    account.private_key
  );
  const assertion = `${unsigned}.${base64Url(signature)}`;
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    cache: "no-store",
    signal: AbortSignal.timeout(GENERIC_EXTERNAL_TIMEOUT_MS),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const payload = await readBoundedJson(response);
  const token =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).access_token
      : null;
  if (!response.ok || typeof token !== "string" || !token) {
    const error = new CloudBillingParseError(
      response.ok
        ? "GOOGLE_BILLING_TOKEN_INVALID"
        : `GOOGLE_BILLING_TOKEN_HTTP_${response.status}`,
      response.status === 401 || response.status === 403
        ? "Google OAuth denied the billing service account."
        : "Google OAuth did not return a usable access token."
    );
    Object.assign(error, { httpStatus: response.status, payload });
    throw error;
  }
  return token;
};

const syncGoogleCloudBilling = async (
  date: Date
): Promise<ProviderUsageSyncResult> => {
  const provider: AiProvider = "google";
  const displayName = PROVIDER_DISPLAY_NAMES[provider];
  const table = process.env.GOOGLE_CLOUD_BILLING_EXPORT_TABLE?.trim();
  const hasCredentials = Boolean(
    process.env.GOOGLE_CLOUD_BILLING_SERVICE_ACCOUNT_JSON?.trim() ||
      process.env.GOOGLE_CLOUD_BILLING_SERVICE_ACCOUNT_JSON_BASE64?.trim()
  );
  if (!hasCredentials || !table) {
    return {
      provider,
      displayName,
      status: "skipped",
      reportedCostMicroUsd: null,
      message:
        "Google Cloud Billing export table or service-account JSON is not configured.",
      diagnostic: null,
    };
  }

  const traceId = crypto.randomUUID();
  let endpoint = GOOGLE_OAUTH_TOKEN_URL;
  let failureStage: ProviderUsageSyncFailureStage = "connection";
  let httpStatus: number | null = null;
  let payload: unknown = null;
  try {
    const account = googleServiceAccount()!;
    const projectId =
      process.env.GOOGLE_CLOUD_BILLING_PROJECT_ID?.trim() || account.project_id;
    if (!projectId || !/^[A-Za-z0-9_-]+$/.test(projectId)) {
      throw new CloudBillingParseError(
        "GOOGLE_BILLING_PROJECT_INVALID",
        "GOOGLE_CLOUD_BILLING_PROJECT_ID is missing or invalid."
      );
    }
    validateGoogleBillingExportTable(table);
    const token = await googleAccessToken(account);
    endpoint = `${GOOGLE_BIGQUERY_API}/projects/${encodeURIComponent(projectId)}/queries`;
    failureStage = "connection";
    const response = await fetch(endpoint, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        googleCloudBillingQueryRequest(
          table,
          date,
          process.env.GOOGLE_CLOUD_BILLING_LOCATION?.trim()
        )
      ),
    });
    httpStatus = response.status;
    failureStage = "response";
    payload = await readBoundedJson(response);
    if (!response.ok) {
      failureStage = "provider_http";
      return failedResult({
        provider,
        date,
        message:
          response.status === 401 || response.status === 403
            ? "Google BigQuery denied billing-export access. Verify the service-account IAM role."
            : `Google BigQuery Billing query returned ${response.status}.`,
        diagnostic: {
          traceId,
          source: "google_cloud_billing",
          endpoint: endpointLabel(endpoint),
          httpStatus: response.status,
          errorType: diagnosticValue(payload, "status"),
          errorCode:
            diagnosticValue(payload, "reason") ||
            `GOOGLE_BILLING_HTTP_${response.status}`,
          providerRequestId: redactProviderDiagnostic(
            response.headers.get("x-guploader-uploadid"),
            160
          ),
          detail: diagnosticValue(payload, "message"),
          failureStage,
        },
      });
    }
    failureStage = "payload";
    const parsed = parseGoogleCloudBillingQuery(payload);
    failureStage = "storage";
    await recordProviderReportedUsage({
      provider,
      date,
      costMicroUsd: parsed.costMicroUsd,
      payload: {
        source: "google_cloud_billing",
        date: date.toISOString().slice(0, 10),
        exportTable: table,
        rowCount: parsed.rowCount,
        invalidCurrencyRateRows: parsed.invalidCurrencyRateRows,
        currency: "USD",
      },
    });
    return {
      provider,
      displayName,
      status: "synced",
      reportedCostMicroUsd: parsed.costMicroUsd,
      message: "Google Cloud Billing export net costs were reconciled.",
      diagnostic: null,
    };
  } catch (error) {
    const status =
      error && typeof error === "object" && "httpStatus" in error
        ? Number((error as { httpStatus?: unknown }).httpStatus) || httpStatus
        : httpStatus;
    const errorPayload =
      error && typeof error === "object" && "payload" in error
        ? (error as { payload?: unknown }).payload
        : payload;
    return failedResult({
      provider,
      date,
      message: isTimeoutError(error)
        ? "Google Cloud Billing query timed out."
        : "Google Cloud Billing export could not be reconciled.",
      diagnostic: {
        traceId,
        source: "google_cloud_billing",
        endpoint: endpointLabel(endpoint),
        httpStatus: status,
        errorType: error instanceof Error ? error.name : null,
        errorCode:
          error instanceof CloudBillingParseError
            ? error.code
            : "GOOGLE_BILLING_SYNC_FAILED",
        providerRequestId: null,
        detail:
          diagnosticValue(errorPayload, "message") ||
          (error instanceof Error
            ? redactProviderDiagnostic(error.message)
            : "Google Cloud Billing request failed."),
        failureStage,
      },
      cause: error,
    });
  }
};

const syncAlibabaCloudBilling = async (
  date: Date
): Promise<ProviderUsageSyncResult> => {
  const provider: AiProvider = "qwen";
  const displayName = PROVIDER_DISPLAY_NAMES[provider];
  const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID?.trim();
  const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET?.trim();
  if (!accessKeyId || !accessKeySecret) {
    return {
      provider,
      displayName,
      status: "skipped",
      reportedCostMicroUsd: null,
      message: "Alibaba Cloud Billing RAM access key is not configured.",
      diagnostic: null,
    };
  }

  const endpoint =
    process.env.ALIBABA_CLOUD_BILLING_ENDPOINT?.trim() ||
    ALIBABA_BILLING_DEFAULT_ENDPOINT;
  const traceId = crypto.randomUUID();
  let page = 1;
  let costUsd = 0;
  let itemCount = 0;
  let expectedTotal = 0;
  let lastHttpStatus: number | null = null;
  let lastRequestId: string | null = null;
  let failureStage: ProviderUsageSyncFailureStage = "connection";
  try {
    do {
      if (page > MAX_ALIBABA_BILLING_PAGES) {
        throw new CloudBillingParseError(
          "ALIBABA_BILLING_PAGE_LIMIT",
          "Alibaba Cloud Billing pagination exceeded the 50,000-row API safety limit."
        );
      }
      const request = createAlibabaCloudBillingRequest({
        endpoint,
        accessKeyId,
        accessKeySecret,
        securityToken: process.env.ALIBABA_CLOUD_SECURITY_TOKEN?.trim(),
        date,
        pageNumber: page,
        productCode: process.env.ALIBABA_CLOUD_BILLING_PRODUCT_CODE?.trim(),
        nonce: crypto.randomUUID(),
      });
      failureStage = "connection";
      const response = await fetch(request.url, {
        method: "POST",
        cache: "no-store",
        signal: AbortSignal.timeout(GENERIC_EXTERNAL_TIMEOUT_MS),
        headers: {
          ...request.headers,
          Accept: "application/json",
        },
        body: request.body,
      });
      lastHttpStatus = response.status;
      failureStage = "response";
      const payload = await readBoundedJson(response);
      lastRequestId =
        redactProviderDiagnostic(
          response.headers.get("x-acs-request-id") ||
            diagnosticValue(payload, "RequestId"),
          160
        ) || lastRequestId;
      if (!response.ok) {
        failureStage = "provider_http";
        return failedResult({
          provider,
          date,
          message:
            response.status === 401 || response.status === 403
              ? "Alibaba Cloud Billing denied access. Grant the RAM user read-only BSS billing permission."
              : `Alibaba Cloud Billing returned ${response.status}.`,
          diagnostic: {
            traceId,
            source: "alibaba_cloud_billing",
            endpoint: endpointLabel(request.url),
            httpStatus: response.status,
            errorType: diagnosticValue(payload, "Code"),
            errorCode:
              diagnosticValue(payload, "Code") ||
              `ALIBABA_BILLING_HTTP_${response.status}`,
            providerRequestId: lastRequestId,
            detail: diagnosticValue(payload, "Message"),
            attemptCount: page,
            failureStage,
          },
        });
      }
      failureStage = "payload";
      const parsed = parseAlibabaCloudBillingPage(payload);
      costUsd += parsed.costUsd;
      itemCount += parsed.itemCount;
      expectedTotal = parsed.totalCount;
      lastRequestId = parsed.requestId || lastRequestId;
      if (expectedTotal > 50_000) {
        throw new CloudBillingParseError(
          "ALIBABA_BILLING_ROW_LIMIT",
          "Alibaba Cloud Billing reported more than 50,000 rows; configure ALIBABA_CLOUD_BILLING_PRODUCT_CODE to narrow the bill."
        );
      }
      page += 1;
      if (parsed.itemCount < 300) break;
    } while (itemCount < expectedTotal);

    const reportedCostMicroUsd = Math.round(costUsd * 1_000_000);
    if (!Number.isSafeInteger(reportedCostMicroUsd)) {
      throw new CloudBillingParseError(
        "ALIBABA_BILLING_INVALID_AMOUNT",
        "Alibaba Cloud Billing total is outside the supported micro-USD range."
      );
    }
    failureStage = "storage";
    await recordProviderReportedUsage({
      provider,
      date,
      costMicroUsd: reportedCostMicroUsd,
      payload: {
        source: "alibaba_cloud_billing",
        date: date.toISOString().slice(0, 10),
        costUsd,
        itemCount,
        pageCount: page - 1,
        productCode:
          process.env.ALIBABA_CLOUD_BILLING_PRODUCT_CODE?.trim() || null,
        currency: "USD",
        providerRequestId: lastRequestId,
      },
    });
    return {
      provider,
      displayName,
      status: "synced",
      reportedCostMicroUsd,
      message: "Alibaba Cloud daily instance bills were reconciled.",
      diagnostic: null,
    };
  } catch (error) {
    return failedResult({
      provider,
      date,
      message: isTimeoutError(error)
        ? "Alibaba Cloud Billing timed out after 10 seconds."
        : "Alibaba Cloud Billing response could not be reconciled.",
      diagnostic: {
        traceId,
        source: "alibaba_cloud_billing",
        endpoint: endpointLabel(endpoint),
        httpStatus: lastHttpStatus,
        errorType: error instanceof Error ? error.name : null,
        errorCode:
          error instanceof CloudBillingParseError
            ? error.code
            : "ALIBABA_BILLING_SYNC_FAILED",
        providerRequestId: lastRequestId,
        detail:
          error instanceof Error
            ? redactProviderDiagnostic(error.message)
            : "Alibaba Cloud Billing request failed.",
        attemptCount: page,
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

const zhipuInternalUsage = async (
  date: Date
): Promise<ProviderUsageSyncResult> => {
  const provider: AiProvider = "zhipu";
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
    reconciliationLabel: "Official balance and daily cost APIs unavailable",
    message:
      "Zhipu response Usage, including cached prompt tokens, is costed with the request-time model price snapshot. Maintain a Provider Credit checkpoint and verify it periodically in the Z.AI dashboard.",
    diagnostic: null,
  };
};

const moonshotInternalUsage = async (
  date: Date
): Promise<ProviderUsageSyncResult> => {
  const provider: AiProvider = "moonshot";
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
    reconciliationLabel:
      "Official daily cost API unavailable; live balance is monitored separately",
    message:
      "Moonshot response Usage is costed with the request-time model price snapshot. The Check Balance API remains a separate live prepaid-funds check; verify the monthly total in Kimi API Platform.",
    diagnostic: null,
  };
};

const deepseekInternalUsage = async (
  date: Date
): Promise<ProviderUsageSyncResult> => {
  const provider: AiProvider = "deepseek";
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
    reconciliationLabel:
      "Official daily cost API unavailable; live balance is monitored separately",
    message:
      "DeepSeek response Usage, including cache-hit tokens, is costed with the request-time model price snapshot. The Balance API remains a separate live prepaid-funds check; verify monthly totals with the DeepSeek Usage export.",
    diagnostic: null,
  };
};

const perplexityInternalUsage = async (
  date: Date
): Promise<ProviderUsageSyncResult> => {
  const provider: AiProvider = "perplexity";
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
    usageSourceLabel: "Exact response cost accounting",
    reconciliationLabel: "Official aggregate cost API unavailable",
    message:
      "Perplexity usage.cost.total_cost is captured from each successful response and summed in Tomverse. Verify the period total in the Perplexity Billing dashboard.",
    diagnostic: null,
  };
};

const hasGenericUsageEndpoint = (provider: AiProvider, date: Date) =>
  Boolean(usageUrlFor(provider, date)) &&
  Boolean(
    process.env[`PROVIDER_${envProvider(provider)}_USAGE_COST_JSON_PATH`]
  );

const syncProviderUsage = async (
  provider: AiProvider,
  date: Date
): Promise<ProviderUsageSyncResult> => {
  switch (provider) {
    case "openai":
      return syncOpenAiCosts(date);
    case "anthropic":
      return syncAnthropicCosts(date);
    case "xai":
      return syncXaiUsage(date);
    case "google":
      return syncGoogleCloudBilling(date);
    case "qwen":
      return syncAlibabaCloudBilling(date);
    case "deepseek":
      return hasGenericUsageEndpoint(provider, date)
        ? syncGenericUsage(provider, date)
        : deepseekInternalUsage(date);
    case "mistral":
      return hasGenericUsageEndpoint(provider, date)
        ? syncGenericUsage(provider, date)
        : mistralInternalUsage(date);
    case "zhipu":
      return hasGenericUsageEndpoint(provider, date)
        ? syncGenericUsage(provider, date)
        : zhipuInternalUsage(date);
    case "moonshot":
      return hasGenericUsageEndpoint(provider, date)
        ? syncGenericUsage(provider, date)
        : moonshotInternalUsage(date);
    case "perplexity":
      return perplexityInternalUsage(date);
    default:
      return syncGenericUsage(provider, date);
  }
};

export async function syncProviderUsageForDate(
  requestedDate = defaultProviderUsageSyncDate()
): Promise<ProviderUsageSyncResult[]> {
  const date = dayStartUtc(requestedDate);
  const results: ProviderUsageSyncResult[] = [];

  for (const provider of MONITORED_PROVIDERS) {
    results.push(await syncProviderUsage(provider, date));
  }

  return results;
}
