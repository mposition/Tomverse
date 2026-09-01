import type { AiProvider } from "@/lib/models";
import {
  PROVIDER_API_CONFIGURATION,
  PROVIDER_API_KEY_ENV_NAMES,
} from "@/lib/modelRegistryShared";

/**
 * The model-list path each provider serves, relative to its configured base
 * URL. Most bases already end in the version segment, so `models` is right;
 * the entries here are the providers whose base URL is the bare API origin
 * because the chat client wants it that way.
 *
 * Anthropic is in this list because leaving it out cost a month of daily
 * PROVIDER_MODEL_CATALOG_HTTP_404 failures: its base URL is
 * `https://api.anthropic.com`, so the default produced
 * `https://api.anthropic.com/models` while the catalogue lives at
 * `/v1/models`. A 404 reads as "the provider dropped this endpoint", which is
 * why nothing looked wrong for so long.
 */
const CATALOG_PATHS: Partial<Record<AiProvider, string>> = {
  anthropic: "v1/models",
  perplexity: "v1/models",
  xai: "language-models",
};

export const providerCatalogUrl = (provider: AiProvider, cursor: string | null) => {
  const base = PROVIDER_API_CONFIGURATION[provider].baseUrl;
  const url = new URL(
    `${base.replace(/\/$/, "")}/${CATALOG_PATHS[provider] || "models"}`
  );
  if (provider === "google") {
    url.searchParams.set("pageSize", "1000");
    if (cursor) url.searchParams.set("pageToken", cursor);
  } else if (provider === "anthropic" || provider === "minimax") {
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("after_id", cursor);
  }
  return url;
};

/**
 * The code a rejected credential gets, instead of the HTTP status it arrived
 * as.
 *
 * 401 and 403 are the only statuses in a catalogue scan that are not about the
 * catalogue. Everything else says something went wrong reading a list;
 * these two say the provider refused the key this application sends on *every*
 * request to it -- so the chat traffic carrying that key is failing too, and
 * the scan is merely where it surfaced first. Reporting it as
 * `PROVIDER_MODEL_CATALOG_HTTP_401` puts the wire in front of the operator and
 * leaves the consequence to be inferred, which is how a provider stayed down
 * behind a row in a daily email.
 *
 * Perplexity is the case that prompted this. A GET on this same endpoint is
 * Perplexity's own documented way to check a key, and the two causes it names
 * for the 401 -- a key that is invalid or revoked, and an account with no
 * credit left -- are both facts outside this repository. Neither is
 * recoverable from a status code, so the detail names them.
 */
export const PROVIDER_CATALOG_KEY_REJECTED =
  "PROVIDER_MODEL_CATALOG_KEY_REJECTED";

/**
 * What a failing HTTP status means, as a code an operator can act on.
 *
 * Pure and here rather than beside the fetch, so the classification is
 * testable without a network and without the server-only module the fetch
 * lives in.
 */
export const providerCatalogHttpFailure = (
  provider: AiProvider,
  status: number
): { code: string; detail: string } => {
  if (status !== 401 && status !== 403) {
    return {
      code: `PROVIDER_MODEL_CATALOG_HTTP_${status}`,
      detail: `Model catalog API returned HTTP ${status}.`,
    };
  }
  // Names every accepted spelling, for the same reason
  // PROVIDER_MODEL_CATALOG_KEY_MISSING does: an operator sent to the canonical
  // variable rotates one they are not using.
  return {
    code: PROVIDER_CATALOG_KEY_REJECTED,
    detail:
      `${PROVIDER_API_KEY_ENV_NAMES[provider].join(" / ")} was rejected with ` +
      `HTTP ${status}. The configured key is invalid, revoked, or its account ` +
      `has no credit left. Chat requests to this provider send the same key, ` +
      `so they are failing too.`,
  };
};

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

/**
 * Why an id was not treated as a chat model.
 *
 * Two reasons, kept apart because only one of them is a guess.
 * `non_chat_kind` reads the id's own words -- an embedding model says
 * `embedding` -- and is as reliable as a name can be. `openai_prefix_heuristic`
 * is a bet that OpenAI's chat models always start `gpt-`, `chatgpt-` or `o<n>`,
 * and the day that stops being true the new model is not discovered, not
 * reported, and nothing says so (.github/audits/model-lifecycle-email-2026-08-22.md §6 candidate 10).
 *
 * So the second reason is carried out of the parser instead of vanishing
 * inside a boolean, and the daily report names what it dropped.
 */
export type ChatModelExclusion = "non_chat_kind" | "openai_prefix_heuristic";

export const chatModelExclusion = (
  provider: AiProvider,
  modelId: string
): ChatModelExclusion | null => {
  const id = modelId.toLowerCase();
  if (
    /(embedding|embed-|moderation|whisper|transcri|speech|tts|dall-e|image-gen|imagen|veo|rerank|guard|safeguard)/.test(
      id
    )
  ) {
    return "non_chat_kind";
  }
  if (provider === "openai" && !/^(gpt-|chatgpt-|o\d)/.test(id)) {
    return "openai_prefix_heuristic";
  }
  return null;
};

export const isLikelyChatModelId = (provider: AiProvider, modelId: string) =>
  chatModelExclusion(provider, modelId) === null;

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

/**
 * The models a payload describes, and the ids a guess dropped.
 *
 * Two lists because they answer different questions. The first is what the scan
 * found. The second is what the scan decided not to look at on the strength of
 * `openai_prefix_heuristic` -- ids that survived every "this is not a chat
 * model" test and were excluded only by the shape of their name.
 *
 * Reported rather than raised: OpenAI always lists a few of these
 * (`davinci-002` and friends), so an alert would be daily noise. What the
 * report has to make impossible is the silent case -- a genuinely new chat
 * model shaped unlike its predecessors, dropped with no trace.
 */
export type ProviderCatalogParse = {
  observations: ProviderCatalogObservation[];
  heuristicallyExcluded: string[];
};

export function parseProviderCatalogModels(
  provider: AiProvider,
  payload: unknown
): ProviderCatalogParse {
  const direct = Array.isArray(payload) ? payload : null;
  const root = record(payload);
  if (!root && !direct) return { observations: [], heuristicallyExcluded: [] };
  const source =
    direct ||
    (Array.isArray(root?.data) && root.data) ||
    (Array.isArray(root?.models) && root.models) ||
    [];
  const heuristicallyExcluded = new Set<string>();
  const noteExclusion = (candidate: string | null | undefined) => {
    if (
      candidate &&
      chatModelExclusion(provider, candidate) === "openai_prefix_heuristic"
    ) {
      heuristicallyExcluded.add(candidate);
    }
  };

  const observations = source.flatMap((value) => {
    const item = record(value);
    if (!item) return [];
    const observation = observationFromItem(provider, item);
    if (!observation) {
      noteExclusion(
        provider === "google"
          ? text(item.baseModelId) || text(item.name)?.replace(/^models\//, "")
          : text(item.id) || text(item.name)
      );
      return [];
    }
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
            noteExclusion(alias);
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
  return {
    observations: Array.from(
      new Map(
        observations.map((observation) => [observation.id, observation])
      ).values()
    ),
    heuristicallyExcluded: Array.from(heuristicallyExcluded).sort(),
  };
}

/**
 * The observations alone, for callers that do not report coverage.
 * Kept so the parser's existing shape is still available unchanged.
 */
export const parseProviderCatalogResponse = (
  provider: AiProvider,
  payload: unknown
) => parseProviderCatalogModels(provider, payload).observations;

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
