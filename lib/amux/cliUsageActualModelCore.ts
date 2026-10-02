/** Dark v26 classifier for a persisted, DB-validated CLI usage receipt.
 * A selected/requested model is deliberately not an input. This function does
 * not authorize collection, aggregation, retention deletion or publication. */

export const AMUX_CLI_ACTUAL_MODEL_UNKNOWN = "actualModelUnknown";
export const AMUX_CLI_ACTUAL_MODEL_MULTIPLE = "multi_model";

const MODEL_ID = /^[A-Za-z0-9._/\[\]-]{1,160}$/;
const COUNT_FIELDS = [
  "inputTokens", "outputTokens", "cacheReadInputTokens",
  "cacheCreationInputTokens",
] as const;

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) =>
    Object.hasOwn(value, key));
}

function observedModelIds(modelsJson: unknown): string[] {
  if (!Array.isArray(modelsJson) || modelsJson.length > 16) {
    throw new Error("AMUX CLI actual model evidence has an invalid shape");
  }
  const seen = new Set<string>();
  for (const item of modelsJson) {
    const model = record(item);
    const observed = model ? record(model.observed) : null;
    if (!model || !exactKeys(model, ["modelId", "observed"]) ||
        !observed || !exactKeys(observed, [...COUNT_FIELDS, "reasoningOutputTokens"]) ||
        observed.reasoningOutputTokens !== null ||
        COUNT_FIELDS.some((field) =>
          typeof observed[field] !== "number" ||
          !Number.isSafeInteger(observed[field]) ||
          (observed[field] as number) < 0) ||
        typeof model.modelId !== "string" || !MODEL_ID.test(model.modelId) ||
        model.modelId.split("/").some((part) => part === "" || part === "." || part === "..") ||
        model.modelId.toLowerCase() === AMUX_CLI_ACTUAL_MODEL_UNKNOWN.toLowerCase() ||
        model.modelId.toLowerCase() === AMUX_CLI_ACTUAL_MODEL_MULTIPLE.toLowerCase() ||
        seen.has(model.modelId)) {
      throw new Error("AMUX CLI actual model evidence is not attested");
    }
    seen.add(model.modelId);
  }
  return [...seen];
}

/** The v22 receipt's Claude modelUsage is actual-model evidence. Codex CLI
 * usage currently does not attest its served model, even when selectedModelId
 * names one; unknown and multi-model are distinct leaf labels. */
export function classifyAmuxCliActualModel(args: {
  cli: "codex" | "claude";
  completeness: "reported_complete" | "reported_partial" | "unknown";
  modelsJson: unknown;
}): string {
  if (!args || !["codex", "claude"].includes(args.cli) ||
      !["reported_complete", "reported_partial", "unknown"].includes(args.completeness)) {
    throw new Error("AMUX CLI actual model classification scope is invalid");
  }
  const models = observedModelIds(args.modelsJson);
  if (args.cli === "codex" || args.completeness === "unknown") {
    if (models.length !== 0) {
      throw new Error("AMUX CLI actual model evidence conflicts with receipt state");
    }
    return AMUX_CLI_ACTUAL_MODEL_UNKNOWN;
  }
  if (args.completeness === "reported_complete" && models.length === 0) {
    throw new Error("AMUX CLI completed Claude receipt lacks model evidence");
  }
  if (models.length > 1) return AMUX_CLI_ACTUAL_MODEL_MULTIPLE;
  // A failed/partial result can attest one observed model without proving no
  // other model served earlier. Do not claim exclusivity from partial usage.
  return models.length === 1 && args.completeness === "reported_complete"
    ? models[0] : AMUX_CLI_ACTUAL_MODEL_UNKNOWN;
}
