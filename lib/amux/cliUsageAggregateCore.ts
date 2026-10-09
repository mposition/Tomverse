/** Privacy-preserving, non-overlapping long-term CLI usage cells.
 * A provider's whole closed year uses one granularity: mixing child and
 * parent cells would expose suppressed small groups by subtraction. */
export type AmuxCliUsageFact = {
  month: string;
  provider: "openai" | "anthropic";
  model: string;
  role: string;
  calls: number;
  reportedCalls: number;
  inputTokens: bigint;
  outputTokens: bigint;
  cacheReadInputTokens: bigint;
  cacheCreationInputTokens: bigint;
  projectedApiCostMicrousd: bigint;
  projectedCalls: number;
};

export type AmuxCliUsageAggregateCell = Omit<AmuxCliUsageFact,
  "month" | "calls" | "model" | "role"> & {
  grain: "month_role_model" | "month_model" | "month_provider" |
    "quarter_provider" | "year_provider";
  periodStart: string;
  model: string | null;
  role: string | null;
  calls: number;
};

const GRAINS: AmuxCliUsageAggregateCell["grain"][] = [
  "month_role_model", "month_model", "month_provider",
  "quarter_provider", "year_provider",
];

function period(month: string, grain: AmuxCliUsageAggregateCell["grain"]): string {
  if (grain === "year_provider") return `${month.slice(0, 4)}-01`;
  if (grain === "quarter_provider") {
    const start = 1 + Math.floor((Number(month.slice(5, 7)) - 1) / 3) * 3;
    return `${month.slice(0, 4)}-${String(start).padStart(2, "0")}`;
  }
  return month;
}

export function rollupAmuxCliUsageFacts(facts: AmuxCliUsageFact[]):
  AmuxCliUsageAggregateCell[] {
  const result: AmuxCliUsageAggregateCell[] = [];
  for (const provider of ["openai", "anthropic"] as const) {
    const selected = facts.filter((fact) => fact.provider === provider);
    if (selected.length === 0) continue;
    for (const grain of GRAINS) {
      const cells = new Map<string, AmuxCliUsageAggregateCell>();
      for (const fact of selected) {
        const periodStart = period(fact.month, grain);
        const model = grain === "month_role_model" || grain === "month_model"
          ? fact.model : null;
        const role = grain === "month_role_model" ? fact.role : null;
        const key = JSON.stringify([periodStart, model, role]);
        const current = cells.get(key);
        if (current) {
          current.calls += fact.calls;
          current.reportedCalls += fact.reportedCalls;
          current.inputTokens += fact.inputTokens;
          current.outputTokens += fact.outputTokens;
          current.cacheReadInputTokens += fact.cacheReadInputTokens;
          current.cacheCreationInputTokens += fact.cacheCreationInputTokens;
          current.projectedApiCostMicrousd += fact.projectedApiCostMicrousd;
          current.projectedCalls += fact.projectedCalls;
        } else {
          cells.set(key, { provider, grain, periodStart, model, role,
            calls: fact.calls, reportedCalls: fact.reportedCalls,
            inputTokens: fact.inputTokens, outputTokens: fact.outputTokens,
            cacheReadInputTokens: fact.cacheReadInputTokens,
            cacheCreationInputTokens: fact.cacheCreationInputTokens,
            projectedApiCostMicrousd: fact.projectedApiCostMicrousd,
            projectedCalls: fact.projectedCalls });
        }
      }
      const values = [...cells.values()];
      if (values.every((cell) => cell.calls >= 5)) {
        result.push(...values);
        break;
      }
      // Fewer than five calls across this provider's whole year: nothing
      // survives beyond the raw-row retention boundary.
    }
  }
  return result.sort((a, b) =>
    `${a.provider}:${a.periodStart}:${a.model}:${a.role}`.localeCompare(
      `${b.provider}:${b.periodStart}:${b.model}:${b.role}`));
}
