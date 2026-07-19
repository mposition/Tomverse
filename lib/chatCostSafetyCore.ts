export const CHAT_COST_SAFETY_CODES = [
  "INTERNAL_DAILY_COST_SAFETY_LIMIT",
  "INTERNAL_MONTHLY_COST_SAFETY_LIMIT",
] as const;

export const isChatCostSafetyCode = (value: unknown): value is string =>
  typeof value === "string" &&
  CHAT_COST_SAFETY_CODES.includes(
    value as (typeof CHAT_COST_SAFETY_CODES)[number]
  );

const finiteNonNegative = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

const formatMicroUsd = (value: number) =>
  `US$${(value / 1_000_000).toFixed(4)}`;

export const formatChatCostSafetyDetails = (details: unknown) => {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return "";
  }
  const candidate = details as Record<string, unknown>;
  const required = finiteNonNegative(
    candidate.requiredCostMicroUsd ?? candidate.newEstimatedCostMicroUsd
  );
  const available = finiteNonNegative(candidate.availableCostMicroUsd);
  if (required === null || available === null) return "";

  const parts = [
    `Estimated internal cost: ${formatMicroUsd(required)}`,
    `Remaining safety allowance: ${formatMicroUsd(available)}`,
  ];
  if (typeof candidate.resetAt === "string") {
    const resetAt = new Date(candidate.resetAt);
    if (!Number.isNaN(resetAt.getTime())) {
      const timeZone =
        typeof candidate.timeZone === "string" ? candidate.timeZone : "UTC";
      try {
        parts.push(
          `Reset: ${new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone,
          }).format(resetAt)} (${timeZone})`
        );
      } catch {
        parts.push(`Reset: ${resetAt.toISOString()} (UTC)`);
      }
    }
  }
  return parts.join(" · ");
};
