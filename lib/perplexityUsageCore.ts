export type PerplexityUsageCostSnapshot = {
  source: "perplexity_response_usage";
  currency: "USD";
  totalCostMicroUsd: number;
  inputTokensCostMicroUsd: number | null;
  outputTokensCostMicroUsd: number | null;
  reasoningTokensCostMicroUsd: number | null;
  requestCostMicroUsd: number | null;
  citationTokensCostMicroUsd: number | null;
  searchQueriesCostMicroUsd: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  citationTokens: number | null;
  searchQueries: number | null;
  searchContextSize: string | null;
};

const finiteNonNegative = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (
    typeof value === "string" &&
    /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())
  ) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
};

const safeInteger = (value: unknown) => {
  const parsed = finiteNonNegative(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
};

const usdToMicroUsd = (value: unknown) => {
  const usd = finiteNonNegative(value);
  if (usd === null) return null;
  const microUsd = Math.round(usd * 1_000_000);
  return Number.isSafeInteger(microUsd) ? microUsd : null;
};

export const parsePerplexityUsageCost = (
  payload: unknown
): PerplexityUsageCostSnapshot | null => {
  if (!payload || typeof payload !== "object") return null;
  const usage = (payload as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  const usageRecord = usage as Record<string, unknown>;
  const cost = usageRecord.cost;
  if (!cost || typeof cost !== "object") return null;
  const costRecord = cost as Record<string, unknown>;
  const totalCostMicroUsd = usdToMicroUsd(costRecord.total_cost);
  if (totalCostMicroUsd === null) return null;

  return {
    source: "perplexity_response_usage",
    currency: "USD",
    totalCostMicroUsd,
    inputTokensCostMicroUsd: usdToMicroUsd(costRecord.input_tokens_cost),
    outputTokensCostMicroUsd: usdToMicroUsd(costRecord.output_tokens_cost),
    reasoningTokensCostMicroUsd: usdToMicroUsd(
      costRecord.reasoning_tokens_cost
    ),
    requestCostMicroUsd: usdToMicroUsd(costRecord.request_cost),
    citationTokensCostMicroUsd: usdToMicroUsd(
      costRecord.citation_tokens_cost
    ),
    searchQueriesCostMicroUsd: usdToMicroUsd(
      costRecord.search_queries_cost
    ),
    promptTokens: safeInteger(usageRecord.prompt_tokens),
    completionTokens: safeInteger(usageRecord.completion_tokens),
    totalTokens: safeInteger(usageRecord.total_tokens),
    reasoningTokens: safeInteger(usageRecord.reasoning_tokens),
    citationTokens: safeInteger(usageRecord.citation_tokens),
    searchQueries: safeInteger(usageRecord.num_search_queries),
    searchContextSize:
      typeof usageRecord.search_context_size === "string"
        ? usageRecord.search_context_size.slice(0, 80)
        : null,
  };
};

export const parsePerplexityResponseBody = (
  responseBody: string
): PerplexityUsageCostSnapshot | null => {
  const trimmed = responseBody.trim();
  if (!trimmed) return null;

  try {
    const parsed = parsePerplexityUsageCost(JSON.parse(trimmed));
    if (parsed) return parsed;
  } catch {
    // Streaming responses are Server-Sent Events rather than one JSON object.
  }

  let latest: PerplexityUsageCostSnapshot | null = null;
  for (const line of responseBody.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      latest = parsePerplexityUsageCost(JSON.parse(data)) || latest;
    } catch {
      // Ignore incomplete/non-JSON SSE fields while preserving the latest usage.
    }
  }
  return latest;
};

const addNullable = (values: Array<number | null>) => {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : null;
};

export const combinePerplexityUsageCosts = (
  snapshots: Array<PerplexityUsageCostSnapshot | null>
): PerplexityUsageCostSnapshot | null => {
  const valid = snapshots.filter(
    (snapshot): snapshot is PerplexityUsageCostSnapshot => snapshot !== null
  );
  if (valid.length === 0) return null;
  return {
    source: "perplexity_response_usage",
    currency: "USD",
    totalCostMicroUsd: valid.reduce(
      (sum, snapshot) => sum + snapshot.totalCostMicroUsd,
      0
    ),
    inputTokensCostMicroUsd: addNullable(
      valid.map((snapshot) => snapshot.inputTokensCostMicroUsd)
    ),
    outputTokensCostMicroUsd: addNullable(
      valid.map((snapshot) => snapshot.outputTokensCostMicroUsd)
    ),
    reasoningTokensCostMicroUsd: addNullable(
      valid.map((snapshot) => snapshot.reasoningTokensCostMicroUsd)
    ),
    requestCostMicroUsd: addNullable(
      valid.map((snapshot) => snapshot.requestCostMicroUsd)
    ),
    citationTokensCostMicroUsd: addNullable(
      valid.map((snapshot) => snapshot.citationTokensCostMicroUsd)
    ),
    searchQueriesCostMicroUsd: addNullable(
      valid.map((snapshot) => snapshot.searchQueriesCostMicroUsd)
    ),
    promptTokens: addNullable(valid.map((snapshot) => snapshot.promptTokens)),
    completionTokens: addNullable(
      valid.map((snapshot) => snapshot.completionTokens)
    ),
    totalTokens: addNullable(valid.map((snapshot) => snapshot.totalTokens)),
    reasoningTokens: addNullable(
      valid.map((snapshot) => snapshot.reasoningTokens)
    ),
    citationTokens: addNullable(
      valid.map((snapshot) => snapshot.citationTokens)
    ),
    searchQueries: addNullable(
      valid.map((snapshot) => snapshot.searchQueries)
    ),
    searchContextSize:
      valid.length === 1 ? valid[0].searchContextSize : "multiple_requests",
  };
};
