export const openAiCostsDayRange = (date: Date) => {
  const startTime = Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000
  );
  return { startTime, endTime: startTime + 86_400 };
};

export const anthropicCostsDayRange = (date: Date) => {
  const startingAt = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  const endingAt = new Date(startingAt.getTime() + 86_400_000);
  return {
    startingAt: startingAt.toISOString(),
    endingAt: endingAt.toISOString(),
  };
};

export const anthropicCostsUrl = ({
  baseUrl,
  date,
  page,
}: {
  baseUrl: string;
  date: Date;
  page?: string | null;
}) => {
  const { startingAt, endingAt } = anthropicCostsDayRange(date);
  const url = new URL(baseUrl);
  url.searchParams.set("starting_at", startingAt);
  url.searchParams.set("ending_at", endingAt);
  url.searchParams.set("bucket_width", "1d");
  url.searchParams.set("limit", "1");
  if (page) url.searchParams.set("page", page);
  return url;
};

export const openAiCostsUrl = ({
  baseUrl,
  date,
  page,
}: {
  baseUrl: string;
  date: Date;
  page?: string | null;
}) => {
  const { startTime, endTime } = openAiCostsDayRange(date);
  const url = new URL(baseUrl);
  url.searchParams.set("start_time", String(startTime));
  url.searchParams.set("end_time", String(endTime));
  url.searchParams.set("bucket_width", "1d");
  url.searchParams.set("limit", "1");
  if (page) url.searchParams.set("page", page);
  return url;
};

export const OPENAI_COSTS_DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;
export const OPENAI_COSTS_DEFAULT_MAX_ATTEMPTS = 3;

const boundedInteger = ({
  value,
  fallback,
  minimum,
  maximum,
}: {
  value: string | undefined;
  fallback: number;
  minimum: number;
  maximum: number;
}) => {
  if (!value || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
};

export const openAiCostsRequestPolicy = ({
  timeoutMs,
  maxAttempts,
}: {
  timeoutMs?: string;
  maxAttempts?: string;
} = {}) => ({
  attemptTimeoutMs: boundedInteger({
    value: timeoutMs,
    fallback: OPENAI_COSTS_DEFAULT_ATTEMPT_TIMEOUT_MS,
    minimum: 5_000,
    maximum: 60_000,
  }),
  maxAttempts: boundedInteger({
    value: maxAttempts,
    fallback: OPENAI_COSTS_DEFAULT_MAX_ATTEMPTS,
    minimum: 1,
    maximum: 3,
  }),
});

export const isRetryableOpenAiStatus = (status: number) =>
  status === 408 ||
  status === 409 ||
  status === 429 ||
  (status >= 500 && status <= 599);

const retryAfterHeaderMs = ({
  retryAfter,
  retryAfterMs,
  nowMs,
}: {
  retryAfter: string | null;
  retryAfterMs: string | null;
  nowMs: number;
}) => {
  if (retryAfterMs && /^\d+(?:\.\d+)?$/.test(retryAfterMs.trim())) {
    return Number(retryAfterMs);
  }
  if (!retryAfter) return null;
  if (/^\d+(?:\.\d+)?$/.test(retryAfter.trim())) {
    return Number(retryAfter) * 1_000;
  }
  const retryAt = Date.parse(retryAfter);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - nowMs) : null;
};

export const openAiCostsRetryDelayMs = ({
  attempt,
  retryAfter = null,
  retryAfterMs = null,
  nowMs = Date.now(),
}: {
  attempt: number;
  retryAfter?: string | null;
  retryAfterMs?: string | null;
  nowMs?: number;
}) => {
  const providerDelay = retryAfterHeaderMs({ retryAfter, retryAfterMs, nowMs });
  if (providerDelay !== null && Number.isFinite(providerDelay)) {
    return Math.min(Math.max(Math.round(providerDelay), 0), 10_000);
  }
  return Math.min(500 * 2 ** Math.max(0, attempt - 1), 4_000);
};

export type OpenAiCostsParseErrorCode =
  | "OPENAI_COSTS_INVALID_PAYLOAD"
  | "OPENAI_COSTS_INVALID_CURRENCY"
  | "OPENAI_COSTS_INVALID_AMOUNT";

export class OpenAiCostsParseError extends Error {
  readonly code: OpenAiCostsParseErrorCode;

  constructor(code: OpenAiCostsParseErrorCode, message: string) {
    super(message);
    this.name = "OpenAiCostsParseError";
    this.code = code;
  }
}

export type AnthropicCostsParseErrorCode =
  | "ANTHROPIC_COSTS_INVALID_PAYLOAD"
  | "ANTHROPIC_COSTS_INVALID_CURRENCY"
  | "ANTHROPIC_COSTS_INVALID_AMOUNT";

export class AnthropicCostsParseError extends Error {
  readonly code: AnthropicCostsParseErrorCode;

  constructor(code: AnthropicCostsParseErrorCode, message: string) {
    super(message);
    this.name = "AnthropicCostsParseError";
    this.code = code;
  }
}

const finiteSignedAmount = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { value, normalizedFromString: false };
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    if (
      /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)
    ) {
      const parsed = Number(normalized);
      if (Number.isFinite(parsed)) {
        return { value: parsed, normalizedFromString: true };
      }
    }
  }
  return null;
};

export const parseOpenAiCostsPage = (payload: unknown) => {
  if (!payload || typeof payload !== "object") {
    throw new OpenAiCostsParseError(
      "OPENAI_COSTS_INVALID_PAYLOAD",
      "OpenAI Costs API returned an invalid JSON object."
    );
  }
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.data)) {
    throw new OpenAiCostsParseError(
      "OPENAI_COSTS_INVALID_PAYLOAD",
      "OpenAI Costs API response did not contain a data array."
    );
  }

  let costUsd = 0;
  let lineItemCount = 0;
  let negativeLineItemCount = 0;
  let normalizedStringAmountCount = 0;
  for (const [bucketIndex, bucket] of record.data.entries()) {
    if (!bucket || typeof bucket !== "object") {
      throw new OpenAiCostsParseError(
        "OPENAI_COSTS_INVALID_PAYLOAD",
        `OpenAI Costs API returned an invalid bucket at data[${bucketIndex}].`
      );
    }
    const results = (bucket as Record<string, unknown>).results;
    if (!Array.isArray(results)) {
      throw new OpenAiCostsParseError(
        "OPENAI_COSTS_INVALID_PAYLOAD",
        `OpenAI Costs API response omitted results at data[${bucketIndex}].`
      );
    }

    for (const [resultIndex, result] of results.entries()) {
      const path = `data[${bucketIndex}].results[${resultIndex}]`;
      if (!result || typeof result !== "object") {
        throw new OpenAiCostsParseError(
          "OPENAI_COSTS_INVALID_PAYLOAD",
          `OpenAI Costs API returned an invalid result at ${path}.`
        );
      }
      const amount = (result as Record<string, unknown>).amount;
      if (!amount || typeof amount !== "object") {
        throw new OpenAiCostsParseError(
          "OPENAI_COSTS_INVALID_PAYLOAD",
          `OpenAI Costs API response omitted amount at ${path}.`
        );
      }
      const amountRecord = amount as Record<string, unknown>;
      const currency =
        typeof amountRecord.currency === "string"
          ? amountRecord.currency.toLowerCase()
          : null;
      if (currency !== "usd") {
        throw new OpenAiCostsParseError(
          "OPENAI_COSTS_INVALID_CURRENCY",
          `OpenAI Costs API returned an unsupported or missing currency at ${path}.`
        );
      }
      const amountValue = finiteSignedAmount(amountRecord.value);
      if (!amountValue) {
        throw new OpenAiCostsParseError(
          "OPENAI_COSTS_INVALID_AMOUNT",
          `OpenAI Costs API returned a non-numeric amount at ${path} (${typeof amountRecord.value}).`
        );
      }
      lineItemCount += 1;
      if (amountValue.value < 0) negativeLineItemCount += 1;
      if (amountValue.normalizedFromString) normalizedStringAmountCount += 1;
      costUsd += amountValue.value;
      if (!Number.isFinite(costUsd)) {
        throw new OpenAiCostsParseError(
          "OPENAI_COSTS_INVALID_AMOUNT",
          "OpenAI Costs API returned an amount total outside the supported numeric range."
        );
      }
    }
  }

  const nextPage =
    typeof record.next_page === "string" && record.next_page.trim()
      ? record.next_page
      : null;
  return {
    costUsd,
    lineItemCount,
    negativeLineItemCount,
    normalizedStringAmountCount,
    hasMore: record.has_more === true,
    nextPage,
  };
};

export const parseAnthropicCostsPage = (payload: unknown) => {
  if (!payload || typeof payload !== "object") {
    throw new AnthropicCostsParseError(
      "ANTHROPIC_COSTS_INVALID_PAYLOAD",
      "Anthropic Cost API returned an invalid JSON object."
    );
  }
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.data)) {
    throw new AnthropicCostsParseError(
      "ANTHROPIC_COSTS_INVALID_PAYLOAD",
      "Anthropic Cost API response did not contain a data array."
    );
  }

  let costMicroUsd = 0;
  let lineItemCount = 0;
  for (const [bucketIndex, bucket] of record.data.entries()) {
    if (!bucket || typeof bucket !== "object") {
      throw new AnthropicCostsParseError(
        "ANTHROPIC_COSTS_INVALID_PAYLOAD",
        `Anthropic Cost API returned an invalid bucket at data[${bucketIndex}].`
      );
    }
    const results = (bucket as Record<string, unknown>).results;
    if (!Array.isArray(results)) {
      throw new AnthropicCostsParseError(
        "ANTHROPIC_COSTS_INVALID_PAYLOAD",
        `Anthropic Cost API response omitted results at data[${bucketIndex}].`
      );
    }

    for (const [resultIndex, result] of results.entries()) {
      const path = `data[${bucketIndex}].results[${resultIndex}]`;
      if (!result || typeof result !== "object") {
        throw new AnthropicCostsParseError(
          "ANTHROPIC_COSTS_INVALID_PAYLOAD",
          `Anthropic Cost API returned an invalid result at ${path}.`
        );
      }
      const resultRecord = result as Record<string, unknown>;
      const currency =
        typeof resultRecord.currency === "string"
          ? resultRecord.currency.toUpperCase()
          : null;
      if (currency !== "USD") {
        throw new AnthropicCostsParseError(
          "ANTHROPIC_COSTS_INVALID_CURRENCY",
          `Anthropic Cost API returned an unsupported or missing currency at ${path}.`
        );
      }
      if (
        typeof resultRecord.amount !== "string" ||
        !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(resultRecord.amount.trim())
      ) {
        throw new AnthropicCostsParseError(
          "ANTHROPIC_COSTS_INVALID_AMOUNT",
          `Anthropic Cost API returned an invalid decimal-cent amount at ${path}.`
        );
      }
      const amountInCents = Number(resultRecord.amount);
      const lineItemMicroUsd = amountInCents * 10_000;
      if (!Number.isFinite(lineItemMicroUsd)) {
        throw new AnthropicCostsParseError(
          "ANTHROPIC_COSTS_INVALID_AMOUNT",
          `Anthropic Cost API returned an amount outside the supported numeric range at ${path}.`
        );
      }
      costMicroUsd += lineItemMicroUsd;
      if (!Number.isFinite(costMicroUsd)) {
        throw new AnthropicCostsParseError(
          "ANTHROPIC_COSTS_INVALID_AMOUNT",
          "Anthropic Cost API returned an amount total outside the supported numeric range."
        );
      }
      lineItemCount += 1;
    }
  }

  const nextPage =
    typeof record.next_page === "string" && record.next_page.trim()
      ? record.next_page
      : null;
  return {
    costMicroUsd: Math.round(costMicroUsd),
    lineItemCount,
    hasMore: record.has_more === true,
    nextPage,
  };
};

export const redactProviderDiagnostic = (value: unknown, maxLength = 300) => {
  if (typeof value !== "string") return null;
  const sanitized = value
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-ant-(?:admin\d*|api\d*)-[A-Za-z0-9_-]{8,}\b/gi, "sk-ant-[REDACTED]")
    .replace(/\bsk-(?:admin-)?[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized ? sanitized.slice(0, maxLength) : null;
};
