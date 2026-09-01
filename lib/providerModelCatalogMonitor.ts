import "server-only";

import type { Prisma } from "@prisma/client";
import type { AiProvider } from "@/lib/models";
import { prisma } from "@/lib/prisma";
import {
  AI_PROVIDERS,
  PROVIDER_API_KEY_ENV_NAMES,
  resolveProviderApiKey,
} from "@/lib/modelRegistryShared";
import { recordDiscoveredWorkItems } from "@/lib/modelLifecycleWorkItems";
import { candidateIdentity } from "@/lib/modelLifecycleWorkItemCore";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
  catalogNextCursor,
  missingConfirmationRuns,
  parseProviderCatalogModels,
  providerCatalogHttpFailure,
  providerCatalogUrl,
  PROVIDER_CATALOG_KEY_REJECTED,
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
  /**
   * Ids dropped only because their name did not match the OpenAI chat prefix.
   *
   * Reported so the guess is visible. If OpenAI ships a chat model shaped
   * unlike its predecessors, this is where it appears -- otherwise it is not
   * discovered, not reported, and nothing says so (.github/audits/model-lifecycle-email-2026-08-22.md §6 candidate 10).
   */
  heuristicallyExcluded: string[];
  /** The page budget ran out with more pages to read. */
  truncated: boolean;
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
  if (provider === "anthropic" || provider === "minimax") {
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

const fetchJson = async (provider: AiProvider, apiKey: string, cursor: string | null) => {
  const response = await fetch(providerCatalogUrl(provider, cursor), {
    method: "GET",
    headers: providerHeaders(provider, apiKey),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const failure = providerCatalogHttpFailure(provider, response.status);
    throw new CatalogRequestError(failure.code, failure.detail);
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
  const apiKey = resolveProviderApiKey(provider);
  if (!apiKey) {
    // Names every accepted spelling: reporting only the canonical one sent an
    // operator to set a variable they had already set under another name.
    throw new CatalogRequestError(
      "PROVIDER_MODEL_CATALOG_KEY_MISSING",
      `${PROVIDER_API_KEY_ENV_NAMES[provider].join(" / ")} is not configured.`
    );
  }

  const observations = new Map<string, ProviderCatalogObservation>();
  const heuristicallyExcluded = new Set<string>();
  let cursor: string | null = null;
  // Set when the page budget runs out with a cursor still pointing somewhere.
  // The loop used to end there in silence, and a scan that stopped early looks
  // exactly like a scan that finished -- so every model past the cut would be
  // reported "missing" with no hint that nobody had looked.
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await fetchJson(provider, apiKey, cursor);
    const parsed = parseProviderCatalogModels(provider, payload);
    for (const observation of parsed.observations) {
      observations.set(observation.id, observation);
    }
    for (const id of parsed.heuristicallyExcluded) heuristicallyExcluded.add(id);
    const next = catalogNextCursor(provider, payload);
    if (!next || next === cursor) break;
    cursor = next;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  if (observations.size === 0) {
    throw new CatalogRequestError(
      "PROVIDER_MODEL_CATALOG_EMPTY",
      "Model catalog API returned no chat-capable models."
    );
  }
  return {
    observations: Array.from(observations.values()),
    heuristicallyExcluded: Array.from(heuristicallyExcluded).sort(),
    truncated,
  };
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
  let scan: Awaited<ReturnType<typeof fetchProviderCatalog>>;
  try {
    scan = await fetchProviderCatalog(provider);
  } catch (error) {
    const safe = safeError(error);
    const status = safe.code === "PROVIDER_MODEL_CATALOG_KEY_MISSING" ? "skipped" : "failed";
    if (safe.code === PROVIDER_CATALOG_KEY_REJECTED) {
      // Loud, and not because the scan failed. A refused key is refused on
      // every path that carries it, so this provider's chat turns are failing
      // for every user right now -- and the only thing that said so was a
      // `failed (PROVIDER_MODEL_CATALOG_HTTP_401)` cell in a daily model
      // report, next to eleven providers that were fine.
      //
      // The code carries the provider because the notification cooldown is
      // keyed on the code alone: one shared code means the first rejected
      // provider silences the rest, and a deploy that drops credentials drops
      // more than one at a time. Same shape as the provider budget alerts.
      await reportOperationalIncident({
        code: `${PROVIDER_CATALOG_KEY_REJECTED}_${provider.toUpperCase()}`,
        title: "A provider rejected the API key Tomverse is configured with",
        error: safe.detail,
        severity: "error",
        context: { component: "provider-model-catalog", provider },
      });
    }
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
      heuristicallyExcluded: [],
      truncated: false,
      errorCode: safe.code,
      errorDetail: safe.detail,
    };
  }

  const observations = scan.observations;

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

  // Whether *this* provider serves a model we have is a provider-scoped
  // question, and `registry` above answers it: that is what missing-detection
  // and the reconciler act on.
  //
  // Whether a model is new to us is not. Judging it inside one provider's slice
  // is what made the same model a fresh candidate every time another provider
  // started serving it -- `kimi-k3` was reported as new three times, the last
  // of them three weeks after it shipped, because Perplexity and Qwen list it
  // and Moonshot is where we registered it (ML-12).
  //
  // The observation rows below stay per provider. They are facts. Collapsing
  // belongs to the layer that decides, not the layer that records.
  const catalogueIdentities = new Set(
    (
      await prisma.modelRegistryEntry.findMany({
        where: { catalogDeleted: false },
        select: { apiModel: true },
      })
    ).map((model) => candidateIdentity(model.apiModel))
  );
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
      else if (
        !observation.lifecycle &&
        !catalogueIdentities.has(candidateIdentity(observation.id))
      ) {
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
  if (scan.truncated) {
    // Loud, because it should not happen: five pages of a thousand is far more
    // than any provider lists today. What makes it worth an incident rather
    // than a note is what it does to the *next* section of the report -- every
    // model past the cut is absent from a run that reported success, and
    // absence is how a retirement is detected.
    await reportOperationalIncident({
      code: "PROVIDER_MODEL_CATALOG_TRUNCATED",
      title: "A provider catalogue scan stopped at its page limit",
      error: `${provider} still had pages left after ${MAX_PAGES}; models beyond that point were not seen and must not be read as missing.`,
      severity: "warning",
      context: {
        component: "provider-model-catalog",
        provider,
        maxPages: MAX_PAGES,
        discovered: observations.length,
      },
    });
  }

  return {
    provider,
    status: "checked",
    discovered: observations.length,
    mapped,
    candidates: candidates.sort(),
    newCandidates: newCandidates.sort(),
    missing,
    lifecycleWarnings,
    heuristicallyExcluded: scan.heuristicallyExcluded,
    truncated: scan.truncated,
  };
};

export async function checkProviderModelCatalogs(now = new Date()) {
  const confirmationRuns = missingConfirmationRuns(
    process.env.PROVIDER_MODEL_MISSING_CONFIRMATION_RUNS
  );
  const results = await Promise.all(
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
          heuristicallyExcluded: [],
          truncated: false,
          errorCode: safe.code,
          errorDetail: safe.detail,
        };
      })
    )
  );

  // The queue is fed from `candidates` -- every unmapped model this scan saw --
  // and never from `newCandidates`, which is empty on every run after the
  // first and is the reason a discovered model was named once and lost.
  // Deciding what is actually new is the queue's job, across all providers at
  // once so one model is one decision.
  //
  // Wrapped because a queue write must not fail the scan: the observations and
  // the reconciliation above are already committed, and losing them to a
  // bookkeeping error would be a worse trade than a missed work item, which the
  // next run creates anyway.
  try {
    await recordDiscoveredWorkItems({
      observed: results.flatMap((result) =>
        result.status === "checked"
          ? result.candidates.map((apiModel) => ({
              provider: result.provider,
              apiModel,
            }))
          : []
      ),
      now,
    });
  } catch (error) {
    console.error("Model lifecycle work item write failed:", {
      reason: error instanceof Error ? error.name : "unknown",
    });
  }

  return results;
}
