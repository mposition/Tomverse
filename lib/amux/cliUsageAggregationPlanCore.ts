import {
  AMUX_CLI_USAGE_AGGREGATE_MIN_INVOCATIONS,
  amuxCliUsageRetentionDeadline,
} from "./cliUsageRetentionCore.ts";

/** Dark, content-free v25 planner. A future writer must prove DB ownership of
 * these rows and of serverNow, serialize invocation inserts with provider-year
 * finalization, and persist only the final cells atomically. The grace below
 * is defense in depth, not a replacement for that DB write/finalize fence. */
export type AmuxCliAggregationSource = {
  invocationId: string;
  recordedAt: string;
  actualProviderId: string | null;
  actualModelId: string | null;
  workerRole: string;
  inputTokens: bigint | null;
  outputTokens: bigint | null;
  cacheReadInputTokens: bigint | null;
  cacheCreationInputTokens: bigint | null;
};

type TokenField = "inputTokens" | "outputTokens" |
  "cacheReadInputTokens" | "cacheCreationInputTokens";
const TOKEN_FIELDS: readonly TokenField[] = [
  "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens",
];
export const AMUX_CLI_AGGREGATION_YEAR_CLOSE_GRACE_MS = 24 * 60 * 60 * 1000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

export type AmuxCliAggregateCell = {
  granularity: "month_role" | "month_model" | "month" | "quarter" | "year";
  period: string;
  actualProviderId: string | null;
  actualModelId: string | null;
  workerRole: string | null;
  invocationCount: number;
  tokenSums: Record<TokenField, bigint | null>;
  unknownTokenCounts: Record<TokenField, number>;
};

type WorkingCell = Omit<AmuxCliAggregateCell, "invocationCount" | "tokenSums" | "unknownTokenCounts"> & {
  rows: AmuxCliAggregationSource[];
};

function canonicalInstant(value: string): Date {
  if (typeof value !== "string" || !ISO_UTC.test(value)) {
    throw new Error("AMUX CLI aggregation needs a canonical UTC instant");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error("AMUX CLI aggregation timestamp is invalid");
  }
  return date;
}

function fold(
  cells: WorkingCell[],
  parentKey: (cell: WorkingCell) => string,
  parent: (cell: WorkingCell, rows: AmuxCliAggregationSource[]) => WorkingCell,
): WorkingCell[] {
  const groups = new Map<string, WorkingCell[]>();
  for (const cell of cells) {
    const key = parentKey(cell);
    const siblings = groups.get(key) ?? [];
    siblings.push(cell);
    groups.set(key, siblings);
  }
  return [...groups.values()].flatMap((siblings) =>
    siblings.some((cell) => cell.rows.length < AMUX_CLI_USAGE_AGGREGATE_MIN_INVOCATIONS)
      ? [parent(siblings[0], siblings.flatMap((cell) => cell.rows))]
      : siblings,
  );
}

function quarter(month: string): string {
  return `${month.slice(0, 4)}-Q${Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1}`;
}

/** Plan one provider/year in its entirety. Never expose a partial year: later
 * sibling folding could otherwise disclose a small cell by subtraction. */
export function planAmuxCliProviderYearAggregates(args: {
  year: number;
  actualProviderId: string | null;
  serverNow: string;
  rows: readonly AmuxCliAggregationSource[];
}): { outcome: "empty" | "excluded_small" | "planned"; cells: AmuxCliAggregateCell[] } {
  const { year, actualProviderId, serverNow, rows } = args;
  if (!Number.isSafeInteger(year) || year < 1000 || year > 9998 ||
      (actualProviderId !== null &&
        (typeof actualProviderId !== "string" || !NAME.test(actualProviderId))) ||
      !Array.isArray(rows)) {
    throw new Error("AMUX CLI aggregation scope is invalid");
  }
  const now = canonicalInstant(serverNow);
  const closedAt = Date.UTC(year + 1, 0, 1) +
    AMUX_CLI_AGGREGATION_YEAR_CLOSE_GRACE_MS;
  if (now.getTime() < closedAt) {
    throw new Error("AMUX CLI provider year is still open");
  }
  // Use the earliest possible deletion in the entire year, not the first row
  // supplied by a caller: older rows may already have been deleted.
  const yearStart = new Date(Date.UTC(year, 0, 1)).toISOString();
  if (now.getTime() >= Date.parse(amuxCliUsageRetentionDeadline(yearStart))) {
    throw new Error("AMUX CLI aggregation missed the provider-year deletion deadline");
  }
  if (rows.length === 0) return { outcome: "empty", cells: [] };

  const seen = new Set<string>();
  const leaves = new Map<string, WorkingCell>();
  for (const row of rows) {
    if (!row || typeof row !== "object" ||
        typeof row.invocationId !== "string" || !UUID_V4.test(row.invocationId) ||
        seen.has(row.invocationId) || row.actualProviderId !== actualProviderId ||
        (row.actualModelId !== null &&
          (typeof row.actualModelId !== "string" || !NAME.test(row.actualModelId))) ||
        typeof row.workerRole !== "string" || !NAME.test(row.workerRole) ||
        TOKEN_FIELDS.some((field) => row[field] !== null &&
          (typeof row[field] !== "bigint" || row[field] < BigInt(0)))) {
      throw new Error("AMUX CLI aggregation source row is invalid");
    }
    seen.add(row.invocationId);
    const recorded = canonicalInstant(row.recordedAt);
    if (recorded.getUTCFullYear() !== year || recorded.getTime() > now.getTime()) {
      throw new Error("AMUX CLI aggregation row is outside its provider year");
    }
    const month = row.recordedAt.slice(0, 7);
    const key = JSON.stringify([month, row.actualModelId, row.workerRole]);
    const leaf: WorkingCell = leaves.get(key) ?? {
      granularity: "month_role", period: month, actualProviderId,
      actualModelId: row.actualModelId, workerRole: row.workerRole, rows: [],
    };
    leaf.rows.push(row);
    leaves.set(key, leaf);
  }
  let cells = fold([...leaves.values()],
    (cell) => JSON.stringify([cell.period, cell.actualModelId]),
    (cell, parentRows) => ({ ...cell, granularity: "month_model", workerRole: null,
      rows: parentRows }));
  cells = fold(cells, (cell) => cell.period,
    (cell, parentRows) => ({ ...cell, granularity: "month", actualModelId: null,
      workerRole: null, rows: parentRows }));
  cells = fold(cells, (cell) => quarter(cell.period),
    (cell, parentRows) => ({ ...cell, granularity: "quarter", period: quarter(cell.period),
      actualModelId: null, workerRole: null, rows: parentRows }));
  cells = fold(cells, () => String(year),
    (cell, parentRows) => ({ ...cell, granularity: "year", period: String(year),
      actualModelId: null, workerRole: null, rows: parentRows }));
  if (cells.some((cell) => cell.rows.length < AMUX_CLI_USAGE_AGGREGATE_MIN_INVOCATIONS)) {
    return { outcome: "excluded_small", cells: [] };
  }
  return { outcome: "planned", cells: cells.map((cell) => {
    const tokenSums = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, BigInt(0)])) as
      Record<TokenField, bigint>;
    const unknownTokenCounts = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0])) as
      Record<TokenField, number>;
    for (const row of cell.rows) {
      for (const field of TOKEN_FIELDS) {
        const count = row[field];
        if (count === null) unknownTokenCounts[field] += 1;
        else tokenSums[field] += count;
      }
    }
    // A cell with five invocations may have only one observed value for a
    // particular field. Suppress that field's sum until five reported it.
    const publishedSums = Object.fromEntries(TOKEN_FIELDS.map((field) => [
      field,
      cell.rows.length - unknownTokenCounts[field] >=
        AMUX_CLI_USAGE_AGGREGATE_MIN_INVOCATIONS ? tokenSums[field] : null,
    ])) as Record<TokenField, bigint | null>;
    return {
      granularity: cell.granularity, period: cell.period,
      actualProviderId: cell.actualProviderId, actualModelId: cell.actualModelId,
      workerRole: cell.workerRole, invocationCount: cell.rows.length,
      tokenSums: publishedSums, unknownTokenCounts,
    };
  }) };
}
