export const openAiCostsDayRange = (date: Date) => {
  const startTime = Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000
  );
  return { startTime, endTime: startTime + 86_400 };
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

const finiteNonNegative = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

export const parseOpenAiCostsPage = (payload: unknown) => {
  if (!payload || typeof payload !== "object") {
    throw new Error("OpenAI Costs API returned an invalid JSON object.");
  }
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.data)) {
    throw new Error("OpenAI Costs API response did not contain a data array.");
  }

  let costUsd = 0;
  for (const bucket of record.data) {
    if (!bucket || typeof bucket !== "object") continue;
    const results = (bucket as Record<string, unknown>).results;
    if (!Array.isArray(results)) continue;

    for (const result of results) {
      if (!result || typeof result !== "object") continue;
      const amount = (result as Record<string, unknown>).amount;
      if (!amount || typeof amount !== "object") continue;
      const amountRecord = amount as Record<string, unknown>;
      const currency =
        typeof amountRecord.currency === "string"
          ? amountRecord.currency.toLowerCase()
          : null;
      const value = finiteNonNegative(amountRecord.value);
      if (currency !== "usd" || value === null) {
        throw new Error("OpenAI Costs API returned an invalid USD amount.");
      }
      costUsd += value;
    }
  }

  const nextPage =
    typeof record.next_page === "string" && record.next_page.trim()
      ? record.next_page
      : null;
  return {
    costUsd,
    hasMore: record.has_more === true,
    nextPage,
  };
};

export const redactProviderDiagnostic = (value: unknown, maxLength = 300) => {
  if (typeof value !== "string") return null;
  const sanitized = value
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-(?:admin-)?[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized ? sanitized.slice(0, maxLength) : null;
};
