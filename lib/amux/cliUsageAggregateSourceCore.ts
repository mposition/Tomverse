import type { AmuxCliAggregationSource } from "./cliUsageAggregationPlanCore.ts";
import { classifyAmuxCliActualModel } from "./cliUsageActualModelCore.ts";
import { AMUX_CLI_USAGE_WORKER_ROLES } from "./cliUsageRoleCore.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cacheReadInputTokens",
  "cacheCreationInputTokens"] as const;

/** A projection of the immutable receipt row, not a wire event or CLI output.
 * The future writer must read it from the product DB inside a bounded,
 * serialized provider-year transaction. In particular, recordedAt and role
 * cannot be supplied by a worker or by an LLM. */
export type AmuxCliAggregationReceiptRow = {
  invocationId: string;
  recordedAt: Date;
  contextKind: "worker" | "idea_analysis";
  workerRole: string;
  cli: "codex" | "claude";
  completeness: "reported_complete" | "reported_partial" | "unknown";
  modelsJson: unknown;
  inputTokens: bigint | null;
  outputTokens: bigint | null;
  cacheReadInputTokens: bigint | null;
  cacheCreationInputTokens: bigint | null;
};

/** The current receipt proves neither the served provider nor its region.
 * Therefore all projected rows stay in v25's actualProviderUnknown partition.
 * A later attested-provider path needs its own stored evidence and review. */
export function projectAmuxCliAggregationSource(
  row: AmuxCliAggregationReceiptRow,
): AmuxCliAggregationSource {
  if (!row || typeof row !== "object" ||
      typeof row.invocationId !== "string" || !UUID_V4.test(row.invocationId) ||
      !(row.recordedAt instanceof Date) ||
      !Number.isFinite(row.recordedAt.getTime()) ||
      !["codex", "claude"].includes(row.cli) ||
      !["reported_complete", "reported_partial", "unknown"].includes(row.completeness) ||
      typeof row.workerRole !== "string" ||
      !AMUX_CLI_USAGE_WORKER_ROLES.some((role) => role === row.workerRole) ||
      !((row.contextKind === "worker" && row.workerRole !== "idea_analysis") ||
        (row.contextKind === "idea_analysis" && row.workerRole === "idea_analysis")) ||
      [row.inputTokens, row.outputTokens, row.cacheReadInputTokens,
        row.cacheCreationInputTokens].some((value) =>
        value !== null && (typeof value !== "bigint" || value < BigInt(0)))) {
    throw new Error("AMUX CLI aggregate source is not a valid receipt projection");
  }
  const actualModelId = classifyAmuxCliActualModel({
    cli: row.cli, completeness: row.completeness,
    modelsJson: row.modelsJson,
  });
  // The DB check enforces this on insert; repeat it here so a mistakenly
  // supplied projection cannot attribute totals to an attested model. Unknown
  // receipts have no model detail and retain their nullable totals.
  const models = row.modelsJson;
  if (Array.isArray(models) && models.length > 0 &&
      TOKEN_FIELDS.some((field) => row[field] === null ||
        models.reduce((sum: bigint, model: {
          observed: Record<typeof field, number>;
        }) => sum + BigInt(model.observed[field]), BigInt(0)) !== row[field])) {
    throw new Error("AMUX CLI aggregate source model totals do not match receipt");
  }
  return {
    invocationId: row.invocationId,
    recordedAt: row.recordedAt.toISOString(),
    actualProviderId: null,
    actualModelId,
    workerRole: row.workerRole,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadInputTokens: row.cacheReadInputTokens,
    cacheCreationInputTokens: row.cacheCreationInputTokens,
  };
}
