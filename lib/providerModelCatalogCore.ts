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
  if (provider === "anthropic" && root.has_more === true) {
    return text(root.last_id);
  }
  return null;
};

export const missingConfirmationRuns = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 2 && parsed <= 7 ? parsed : 2;
};
