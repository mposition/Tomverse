const nonNegativeNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

export const normalizeDeepSeekUsagePayload = (payload: unknown): unknown => {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as Record<string, unknown>;
  const rawUsage = record.usage;
  if (!rawUsage || typeof rawUsage !== "object") return payload;
  const usage = rawUsage as Record<string, unknown>;
  const rawCachedTokens = nonNegativeNumber(usage.prompt_cache_hit_tokens);
  if (rawCachedTokens === null) return payload;
  const promptTokens = nonNegativeNumber(usage.prompt_tokens);
  const cachedTokens =
    promptTokens === null
      ? rawCachedTokens
      : Math.min(promptTokens, rawCachedTokens);
  const rawPromptDetails = usage.prompt_tokens_details;
  const promptDetails =
    rawPromptDetails && typeof rawPromptDetails === "object"
      ? (rawPromptDetails as Record<string, unknown>)
      : {};

  return {
    ...record,
    usage: {
      ...usage,
      prompt_tokens_details: {
        ...promptDetails,
        cached_tokens: cachedTokens,
      },
    },
  };
};

export const normalizeDeepSeekSseLine = (line: string) => {
  const match = line.match(/^(\s*data:\s*)([^\r\n]*)(\r?\n?)$/);
  if (!match || match[2] === "[DONE]") return line;
  try {
    const payload = JSON.parse(match[2]) as unknown;
    return `${match[1]}${JSON.stringify(
      normalizeDeepSeekUsagePayload(payload)
    )}${match[3]}`;
  } catch {
    return line;
  }
};
