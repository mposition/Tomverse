import "server-only";

import type { Prisma } from "@prisma/client";
import type { AiProvider } from "@/lib/models";
import { prisma } from "@/lib/prisma";
import {
  AI_PROVIDERS,
  PROVIDER_API_CONFIGURATION,
} from "@/lib/modelRegistryShared";
import {
  catalogNextCursor,
  missingConfirmationRuns,
  parseProviderCatalogResponse,
  type ProviderCatalogObservation,
} from "@/lib/providerModelCatalogCore";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_PAGES = 5;

export type ProviderModelCatalogResult = {
  provider: AiProvider;
  status: "checked" | "skipped" | "failed";
  discovered: number;
  mapped: string[];
  candidates: string[];
  newCandidates: string[];
  missing: Array<{ modelId: string; apiModel: string; consecutiveMissing: number }>;
  lifecycleWarnings: Array<{
    modelId: string | null;
    apiModel: string;
    lifecycle: string;
  }>;
  errorCode?: string;
  errorDetail?: string;
};

class CatalogRequestError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "CatalogRequestError";
  }
}

const providerHeaders = (
  provider: AiProvider,
  apiKey: string
): Record<string, string> => {
  if (provider === "anthropic") {
    return {
      Accept: "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": apiKey,
    };
  }
  if (provider === "google") {
    return { Accept: "application/json", "x-goog-api-key": apiKey };
  }
  return { Accept: "application/json", Authorization: `Bearer ${apiKey}` };
};

const providerCatalogUrl = (
  provider: AiProvider,
  cursor: string | null
) => {
  const base = PROVIDER_API_CONFIGURATION[provider].baseUrl;
  const path =
    provider === "xai"
      ? "language-models"
      : provider === "perplexity"
        ? "v1/models"
        : "models";
  const url = new URL(`${base.replace(/\/$/, "")}/${path}`);
  if (provider === "google") {
    url.searchParams.set("pageSize", "1000");
    if (cursor) url.searchParams.set("pageToken", cursor);
  } else if (provider === "anthropic") {
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("after_id", cursor);
  }
  return url;
};

const fetchJson = async (provider: AiProvider, apiKey: string, cursor: string | null) => {
  const response = await fetch(providerCatalogUrl(provider, cursor), {
    method: "GET",
    headers: providerHeaders(provider, apiKey),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new CatalogRequestError(
      `PROVIDER_MODEL_CATALOG_HTTP_${response.status}`,
      `Model catalog API returned HTTP ${response.status}.`
    );
  }
  const body = await response.text();
  if (body.length > MAX_RESPONSE_BYTES) {
    throw new CatalogRequestError(
      "PROVIDER_MODEL_CATALOG_TOO_LARGE",
      "Model catalog response exceeded the safe size limit."
    );
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new CatalogRequestError(
      "PROVIDER_MODEL_CATALOG_INVALID_JSON",
      "Model catalog API returned invalid JSON."
    );
  }
};

const fetchProviderCatalog = async (provider: AiProvider) => {
  const configuration = PROVIDER_API_CONFIGURATION[provider];
  const apiKey = process.env[configuration.apiKeyEnvName]?.trim();
  if (!apiKey) {
    throw new CatalogRequestError(
      "PROVIDER_MODEL_CATALOG_KEY_MISSING",
      `${configuration.apiKeyEnvName} is not configured.`
    );
  }

  const observations = new Map<string, ProviderCatalogObservation>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await fetchJson(provider, apiKey, cursor);
    for (const observation of parseProviderCatalogResponse(provider, payload)) {
      observations.set(observation.id, observation);
    }
    const next = catalogNextCursor(provider, payload);
    if (!next || next === cursor) break;
    cursor = next;
  }
  if (observations.size === 0) {
    throw new CatalogRequestError(
      "PROVIDER_MODEL_CATALOG_EMPTY",
      "Model catalog API returned no chat-capable models."
    );
  }
  return Array.from(observations.values());
};

const safeError = (error: unknown) => ({
  code:
    error instanceof CatalogRequestError
      ? error.code
      : error instanceof DOMException && error.name === "TimeoutError"
        ? "PROVIDER_MODEL_CATALOG_TIMEOUT"
        : "PROVIDER_MODEL_CATALOG_FAILED",
  detail:
    error instanceof Error
      ? error.message.slice(0, 500)
      : "Provider model catalog request failed.",
});

const runProviderCheck = async (
  provider: AiProvider,
  now: Date,
  confirmationRuns: number
): Promise<ProviderModelCatalogResult> => {
  const run = await prisma.providerModelCatalogRun.create({
    data: { provider, status: "running", startedAt: now },
    select: { id: true },
  });
  let observations: ProviderCatalogObservation[];
  try {
    observations = await fetchProviderCatalog(provider);
  } catch (error) {
    const safe = safeError(error);
    const status = safe.code === "PROVIDER_MODEL_CATALOG_KEY_MISSING" ? "skipped" : "failed";
    await prisma.providerModelCatalogRun.update({
      where: { id: run.id },
      data: {
        status,
        errorCode: safe.code,
        errorDetail: safe.detail,
        completedAt: new Date(),
      },
    });
    return {
      provider,
      status,
      discovered: 0,
      mapped: [],
      candidates: [],
      newCandidates: [],
      missing: [],
      lifecycleWarnings: [],
      errorCode: safe.code,
      errorDetail: safe.detail,
    };
  }

  const registry = await prisma.modelRegistryEntry.findMany({
    where: { provider, catalogDeleted: false },
    select: {
      id: true,
      apiModel: true,
      enabled: true,
      publiclyListed: true,
    },
  });
  const registryByApiModel = new Map(registry.map((model) => [model.apiModel, model]));
  const observedById = new Map(observations.map((item) => [item.id, item]));
  const existingEntries = await prisma.providerModelCatalogEntry.findMany({
    where: { provider },
  });
  const existingByApiModel = new Map(existingEntries.map((entry) => [entry.apiModel, entry]));

  const mapped: string[] = [];
  const candidates: string[] = [];
  const newCandidates: string[] = [];
  const lifecycleWarnings: ProviderModelCatalogResult["lifecycleWarnings"] = [];
  const missing: ProviderModelCatalogResult["missing"] = [];

  await prisma.$transaction(async (tx) => {
    for (const observation of observations) {
      const model = registryByApiModel.get(observation.id);
      const status = observation.lifecycle
        ? "lifecycle_warning"
        : model
          ? "available"
          : "candidate";
      if (model) mapped.push(model.id);
      else if (!observation.lifecycle) {
        candidates.push(observation.id);
        if (!existingByApiModel.has(observation.id)) newCandidates.push(observation.id);
      }
      if (observation.lifecycle) {
        lifecycleWarnings.push({
          modelId: model?.id || null,
          apiModel: observation.id,
          lifecycle: observation.lifecycle,
        });
      }
      const previous = existingByApiModel.get(observation.id);
      await tx.providerModelCatalogEntry.upsert({
        where: { provider_apiModel: { provider, apiModel: observation.id } },
        create: {
          provider,
          apiModel: observation.id,
          modelRegistryId: model?.id || null,
          displayName: observation.displayName,
          status,
          firstSeenAt: now,
          lastSeenAt: now,
          lastCheckedAt: now,
          consecutiveSeen: 1,
          lifecycle: observation.lifecycle,
          metadata: observation.metadata as Prisma.InputJsonValue,
        },
        update: {
          modelRegistryId: model?.id || null,
          displayName: observation.displayName,
          status,
          lastSeenAt: now,
          lastCheckedAt: now,
          missingSinceAt: null,
          consecutiveSeen: (previous?.consecutiveSeen || 0) + 1,
          consecutiveMissing: 0,
          lifecycle: observation.lifecycle,
          metadata: observation.metadata as Prisma.InputJsonValue,
        },
      });
    }

    for (const model of registry) {
      // Perplexity's official list endpoint currently describes Agent API
      // models, while Tomverse's existing Sonar entries use Chat Completions.
      // It is useful for discovery but cannot safely prove Sonar retirement.
      if (provider === "perplexity") continue;
      if (observedById.has(model.apiModel)) continue;
      // Retired/private historical rows remain resolvable but do not page the
      // operator unless they are still enabled or publicly listed.
      if (!model.enabled && !model.publiclyListed) continue;
      const previous = existingByApiModel.get(model.apiModel);
      const consecutiveMissing = (previous?.consecutiveMissing || 0) + 1;
      const status =
        consecutiveMissing >= confirmationRuns ? "likely_deprecated" : "missing";
      missing.push({ modelId: model.id, apiModel: model.apiModel, consecutiveMissing });
      await tx.providerModelCatalogEntry.upsert({
        where: { provider_apiModel: { provider, apiModel: model.apiModel } },
        create: {
          provider,
          apiModel: model.apiModel,
          modelRegistryId: model.id,
          status,
          lastCheckedAt: now,
          missingSinceAt: now,
          consecutiveMissing,
        },
        update: {
          modelRegistryId: model.id,
          status,
          lastCheckedAt: now,
          missingSinceAt: previous?.missingSinceAt || now,
          consecutiveSeen: 0,
          consecutiveMissing,
          lifecycle: null,
        },
      });
    }
  });

  await prisma.providerModelCatalogRun.update({
    where: { id: run.id },
    data: {
      status: "checked",
      discoveredCount: observations.length,
      mappedCount: mapped.length,
      candidateCount: candidates.length,
      missingCount: missing.length,
      lifecycleCount: lifecycleWarnings.length,
      completedAt: new Date(),
    },
  });
  return {
    provider,
    status: "checked",
    discovered: observations.length,
    mapped,
    candidates: candidates.sort(),
    newCandidates: newCandidates.sort(),
    missing,
    lifecycleWarnings,
  };
};

export async function checkProviderModelCatalogs(now = new Date()) {
  const confirmationRuns = missingConfirmationRuns(
    process.env.PROVIDER_MODEL_MISSING_CONFIRMATION_RUNS
  );
  return Promise.all(
    AI_PROVIDERS.map((provider) =>
      runProviderCheck(provider, now, confirmationRuns).catch(async (error) => {
        const safe = safeError(error);
        await prisma.providerModelCatalogRun
          .updateMany({
            where: { provider, status: "running", startedAt: now },
            data: {
              status: "failed",
              errorCode: safe.code,
              errorDetail: safe.detail,
              completedAt: new Date(),
            },
          })
          .catch(() => undefined);
        console.error("Provider model catalog persistence failed:", {
          provider,
          code: safe.code,
        });
        return {
          provider,
          status: "failed" as const,
          discovered: 0,
          mapped: [],
          candidates: [],
          newCandidates: [],
          missing: [],
          lifecycleWarnings: [],
          errorCode: safe.code,
          errorDetail: safe.detail,
        };
      })
    )
  );
}
