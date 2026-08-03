import type { AiProvider } from "@/lib/models";

export type ProviderCatalogObservation = {
  id: string;
  displayName: string | null;
  lifecycle: string | null;
  available: boolean;
  metadata: Record<string, string | number | boolean | null>;
};

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const boolean = (value: unknown) =>
  typeof value === "boolean" ? value : null;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const lifecycleFromRecord = (item: Record<string, unknown>) => {
  if (item.archived === true) return "archived";
  if (item.deprecated === true) return "deprecated";
  const value = text(item.stage) || text(item.lifecycle) || text(item.status);
  if (!value) return null;
  const normalized = value.toLowerCase();
  return ["legacy", "deprecated", "retired", "archived", "sunset"].includes(
    normalized
  )
    ? normalized
    : null;
};

export const isLikelyChatModelId = (provider: AiProvider, modelId: string) => {
  const id = modelId.toLowerCase();
  if (
    /(embedding|embed-|moderation|whisper|transcri|speech|tts|dall-e|image-gen|imagen|veo|rerank|guard|safeguard)/.test(
      id
    )
  ) {
    return false;
  }
  if (provider === "openai") {
    return /^(gpt-|chatgpt-|o\d)/.test(id);
  }
  return true;
};

const observationFromItem = (
  provider: AiProvider,
  item: Record<string, unknown>
): ProviderCatalogObservation | null => {
  const googleName = text(item.baseModelId) || text(item.name)?.replace(/^models\//, "");
  const id = provider === "google" ? googleName : text(item.id) || text(item.name);
  if (!id || id.length > 240 || !/^[a-zA-Z0-9._:/-]+$/.test(id)) return null;

  if (provider === "google") {
    const methods = Array.isArray(item.supportedGenerationMethods)
      ? item.supportedGenerationMethods
      : Array.isArray(item.supportedActions)
        ? item.supportedActions
        : [];
    if (
      methods.length > 0 &&
      !methods.some(
        (method) =>
          typeof method === "string" && method.toLowerCase() === "generatecontent"
      )
    ) {
      return null;
    }
  }

  const capabilities = record(item.capabilities);
  if (
    provider === "mistral" &&
    capabilities &&
    capabilities.completion_chat === false
  ) {
    return null;
  }
  if (!isLikelyChatModelId(provider, id)) return null;

  const lifecycle = lifecycleFromRecord(item);
  const metadata = {
    created: number(item.created),
    createdAt: text(item.created_at),
    ownedBy: text(item.owned_by),
    contextLength: number(item.context_length) || number(item.max_context_length),
    inputTokenLimit: number(item.inputTokenLimit) || number(item.max_input_tokens),
    outputTokenLimit: number(item.outputTokenLimit) || number(item.max_tokens),
    vision:
      boolean(record(capabilities?.vision)?.supported) ??
      boolean(capabilities?.vision) ??
      boolean(record(record(item.capabilities)?.image_input)?.supported),
    thinking:
      boolean(item.thinking) ??
      boolean(record(record(item.capabilities)?.thinking)?.supported),
  };

  return {
    id,
    displayName: text(item.displayName) || text(item.display_name),
    lifecycle,
    available: lifecycle === null,
    metadata,
  };
};

export function parseProviderCatalogResponse(
  provider: AiProvider,
  payload: unknown
) {
  const direct = Array.isArray(payload) ? payload : null;
  const root = record(payload);
  if (!root && !direct) return [];
  const source =
    direct ||
    (Array.isArray(root?.data) && root.data) ||
    (Array.isArray(root?.models) && root.models) ||
    [];
  const observations = source.flatMap((value) => {
    const item = record(value);
    if (!item) return [];
    const observation = observationFromItem(provider, item);
    if (!observation) return [];
    const aliases = Array.isArray(item.aliases)
      ? item.aliases.flatMap((value) => {
          const alias = text(value);
          if (
            !alias ||
            alias === observation.id ||
            alias.length > 240 ||
            !/^[a-zA-Z0-9._:/-]+$/.test(alias) ||
            !isLikelyChatModelId(provider, alias)
          ) {
            return [];
          }
          return [
            {
              ...observation,
              id: alias,
              metadata: { ...observation.metadata, aliasOf: observation.id },
            },
          ];
        })
      : [];
    return [observation, ...aliases];
  });
  return Array.from(
    new Map(observations.map((observation) => [observation.id, observation])).values()
  );
}

export const catalogNextCursor = (provider: AiProvider, payload: unknown) => {
  const root = record(payload);
  if (!root) return null;
  if (provider === "google") return text(root.nextPageToken);
  if (
    (provider === "anthropic" || provider === "minimax") &&
    root.has_more === true
  ) {
    return text(root.last_id);
  }
  return null;
};

export const missingConfirmationRuns = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 2 && parsed <= 7 ? parsed : 2;
};

// F-05 reconciliation. Kept here, pure, for the same reason the parsing above
// is: the decision about whether a model has really been retired is worth
// testing directly, without a database in the way. lib/providerModelCatalog
// Reconciliation.ts does the I/O and nothing else.

export const AUTO_DISABLE_REASON =
  "Auto-disabled: absent from consecutive successful provider catalog scans.";

export const isAutoDisabledReason = (operationalReason: string | null) =>
  Boolean(operationalReason?.startsWith(AUTO_DISABLE_REASON));

export type CatalogReconciliationCheck = {
  provider: AiProvider;
  status: "checked" | "skipped" | "failed";
  missing: ReadonlyArray<{
    modelId: string;
    apiModel: string;
    consecutiveMissing: number;
  }>;
  mapped: readonly string[];
};

export type CatalogRegistryRow = {
  id: string;
  apiModel: string;
  enabled: boolean;
  operationalReason: string | null;
};

export type CatalogReconciliationPlan = {
  disable: Array<{
    provider: AiProvider;
    modelId: string;
    apiModel: string;
    consecutiveMissing: number;
  }>;
  restore: Array<{ provider: AiProvider; modelId: string; apiModel: string }>;
  hold: Array<{
    provider: AiProvider;
    reason: "would_disable_every_enabled_model";
    modelIds: string[];
  }>;
};

export function planCatalogReconciliation(input: {
  check: CatalogReconciliationCheck;
  registry: readonly CatalogRegistryRow[];
  confirmationRuns: number;
}): CatalogReconciliationPlan {
  const plan: CatalogReconciliationPlan = { disable: [], restore: [], hold: [] };
  // Only a completed check proves anything. A failed or skipped provider says
  // nothing about its models, and treating that silence as evidence is the
  // exact mistake the confirmation threshold exists to prevent.
  if (input.check.status !== "checked") return plan;

  const rowById = new Map(input.registry.map((row) => [row.id, row]));
  const enabledIds = new Set(
    input.registry.filter((row) => row.enabled).map((row) => row.id)
  );

  const confirmed = input.check.missing.filter(
    (item) =>
      item.consecutiveMissing >= input.confirmationRuns &&
      enabledIds.has(item.modelId)
  );

  if (confirmed.length > 0 && confirmed.length === enabledIds.size) {
    // A provider retiring its entire lineup at once and a catalog endpoint
    // returning a truncated list are indistinguishable from here, and only one
    // of them should take a whole provider offline.
    plan.hold.push({
      provider: input.check.provider,
      reason: "would_disable_every_enabled_model",
      modelIds: confirmed.map((item) => item.modelId),
    });
  } else {
    for (const item of confirmed) {
      plan.disable.push({
        provider: input.check.provider,
        modelId: item.modelId,
        apiModel: item.apiModel,
        consecutiveMissing: item.consecutiveMissing,
      });
    }
  }

  // Only restore what this automation took away, so a transient catalog gap
  // does no permanent damage while an entry an operator disabled on purpose is
  // never quietly turned back on.
  for (const modelId of input.check.mapped) {
    const row = rowById.get(modelId);
    if (!row || row.enabled || !isAutoDisabledReason(row.operationalReason)) continue;
    plan.restore.push({
      provider: input.check.provider,
      modelId,
      apiModel: row.apiModel,
    });
  }

  return plan;
}
