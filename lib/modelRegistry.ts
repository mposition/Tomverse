import "server-only";

import type { ModelRegistryEntry, Prisma } from "@prisma/client";
import { isMissingDatabaseSchemaError } from "@/lib/databaseError";
import { isE2EDatabaseDisabled } from "@/lib/e2eTestMode";
import { prisma } from "@/lib/prisma";
import {
  getModelUsageProfile,
  isRetiredModel,
  type AiModel,
  type ModelInputCapabilities,
  type ModelMinimumPlan,
  type ModelStatus,
  type ModelUsageClass,
} from "@/lib/models";
import {
  PROVIDER_API_CONFIGURATION,
  STATIC_RUNTIME_MODELS,
  isApprovedProviderApiBaseUrl,
  isApprovedProviderApiKeyEnvName,
  isAiProvider,
  staticModelRegistrySeedRows,
} from "@/lib/modelRegistryShared";

// Evaluated per call rather than captured at module load, so the guard sees the
// real environment regardless of import order.
const E2E_DATABASE_DISABLED = isE2EDatabaseDisabled;

const inputCapabilitiesFromRow = (
  row: ModelRegistryEntry
): ModelInputCapabilities | undefined => {
  if (!row.supportsImage && !row.supportsNativePdf) return undefined;
  return {
    image: row.supportsImage,
    nativePdf: row.supportsNativePdf,
    ...(row.maxImages ? { maxImages: row.maxImages } : {}),
    ...(row.maxBase64ImagePayloadBytes
      ? { maxBase64ImagePayloadBytes: row.maxBase64ImagePayloadBytes }
      : {}),
  };
};

export const registryRowToModel = (row: ModelRegistryEntry): AiModel => {
  if (!isAiProvider(row.provider)) {
    throw new Error(`Model registry entry ${row.id} has an unsupported provider.`);
  }
  if (!isApprovedProviderApiBaseUrl(row.provider, row.apiBaseUrl)) {
    throw new Error(`Model registry entry ${row.id} has a non-allowlisted API Base URL.`);
  }
  if (!isApprovedProviderApiKeyEnvName(row.provider, row.apiKeyEnvName)) {
    throw new Error(`Model registry entry ${row.id} has a non-allowlisted API key reference.`);
  }
  const providerConfiguration = PROVIDER_API_CONFIGURATION[row.provider];
  return {
    id: row.id,
    name: row.name,
    apiModel: row.apiModel,
    provider: row.provider,
    apiBaseUrl: providerConfiguration.baseUrl,
    apiKeyEnvName: providerConfiguration.apiKeyEnvName,
    icon: row.icon,
    bestFor: row.bestFor,
    minimumPlan: row.minimumPlan as ModelMinimumPlan,
    usageClass: row.usageClass as ModelUsageClass,
    creditWeight: row.creditWeight,
    publiclyListed: row.publiclyListed,
    enabled: row.enabled,
    status: row.status as ModelStatus,
    operationalReason: row.operationalReason || undefined,
    userVisibleNote: row.userVisibleNote || undefined,
    replacementModelId: row.replacementModelId || undefined,
    catalogDeleted: row.catalogDeleted,
    reasoning: (row.reasoning as AiModel["reasoning"]) || undefined,
    contextWindowTokens: row.contextWindowTokens || undefined,
    inputCapabilities: inputCapabilitiesFromRow(row),
    maxOutputTokens: row.maxOutputTokens || undefined,
    reservationOutputTokens: row.reservationOutputTokens || undefined,
    inputUsdPerMillionTokens: row.inputUsdPerMillionTokens ?? undefined,
    outputUsdPerMillionTokens: row.outputUsdPerMillionTokens ?? undefined,
    cachedInputPriceMultiplier: row.cachedInputPriceMultiplier ?? undefined,
    sortOrder: row.sortOrder,
  };
};

let bootstrapPromise: Promise<void> | null = null;
let didWarnAboutRegistrySchema = false;

// Retirement is a deliberate, human-authored lifecycle decision (a provider
// stopped serving the model), unlike the tunable fields -- name, blurb,
// pricing, sort order -- that an admin may legitimately diverge from the
// bootstrap catalog on.
const STATIC_RETIRED_MODELS = STATIC_RUNTIME_MODELS.filter(isRetiredModel);

// `createMany({ skipDuplicates: true })` only ever inserts, so a model that
// was already in the runtime registry before it was retired in
// `lib/models.ts` kept its old `enabled`/`publiclyListed`/`status` values
// forever -- the public model API and the picker went on offering a model no
// provider would serve. Retirement is therefore replayed onto existing rows
// on every bootstrap. `catalogDeleted` is deliberately untouched: it stays
// human-controlled.
async function applyStaticRetirements() {
  if (STATIC_RETIRED_MODELS.length === 0) return;

  for (const model of STATIC_RETIRED_MODELS) {
    const result = await prisma.modelRegistryEntry.updateMany({
      where: {
        id: model.id,
        OR: [
          { enabled: true },
          { publiclyListed: true },
          { status: { not: "disabled" } },
        ],
      },
      data: {
        enabled: false,
        publiclyListed: false,
        status: "disabled",
        ...(model.replacementModelId
          ? { replacementModelId: model.replacementModelId }
          : {}),
        ...(model.operationalReason
          ? { operationalReason: model.operationalReason }
          : {}),
        ...(model.userVisibleNote
          ? { userVisibleNote: model.userVisibleNote }
          : {}),
      },
    });

    if (result.count > 0) {
      console.warn(
        "Model registry: applied static catalog retirement to runtime row.",
        {
          modelId: model.id,
          replacementModelId: model.replacementModelId ?? null,
        }
      );
    }
  }
}

export async function ensureModelRegistrySeeded() {
  if (E2E_DATABASE_DISABLED()) return;
  if (!bootstrapPromise) {
    bootstrapPromise = prisma.modelRegistryEntry
      .createMany({ data: staticModelRegistrySeedRows(), skipDuplicates: true })
      .then(() => applyStaticRetirements())
      .catch((error) => {
        bootstrapPromise = null;
        throw error;
      });
  }
  await bootstrapPromise;
}

export async function getRuntimeModels(options?: {
  includeCatalogDeleted?: boolean;
}): Promise<AiModel[]> {
  if (E2E_DATABASE_DISABLED()) {
    return STATIC_RUNTIME_MODELS.filter(
      (model) => options?.includeCatalogDeleted || !model.catalogDeleted
    );
  }

  try {
    await ensureModelRegistrySeeded();
    const rows = await prisma.modelRegistryEntry.findMany({
      where: options?.includeCatalogDeleted ? undefined : { catalogDeleted: false },
      orderBy: [{ sortOrder: "asc" }, { provider: "asc" }, { name: "asc" }],
    });
    return rows.flatMap((row) => {
      try {
        return [registryRowToModel(row)];
      } catch (error) {
        console.error("Ignoring invalid model registry row:", {
          modelId: row.id,
          error: error instanceof Error ? error.message : "Invalid registry row",
        });
        return [];
      }
    });
  } catch (error) {
    // Allows a rolling deploy to start before all registry migrations have
    // reached the DB. Other database failures are deliberately not hidden.
    if (isMissingDatabaseSchemaError(error)) {
      if (!didWarnAboutRegistrySchema) {
        didWarnAboutRegistrySchema = true;
        console.warn(
          "Model registry schema is not migrated yet; using the static bootstrap catalog."
        );
      }
      return STATIC_RUNTIME_MODELS;
    }
    throw error;
  }
}

export async function getRuntimeModel(modelId: string) {
  const models = await getRuntimeModels({ includeCatalogDeleted: true });
  return models.find((model) => model.id === modelId);
}

export async function getEnabledRuntimeModel(modelId: string) {
  const model = await getRuntimeModel(modelId);
  return model?.enabled && !model.catalogDeleted ? model : undefined;
}

export async function isEnabledRuntimeModelId(modelId: string) {
  return Boolean(await getEnabledRuntimeModel(modelId));
}

export async function getPublicRuntimeModels() {
  const models = await getRuntimeModels();
  return models.filter(
    (model) => model.publiclyListed !== false && !model.catalogDeleted
  );
}

export async function clampRuntimeSelectedModels(
  modelIds: string[],
  maximum = 3
) {
  const models = await getRuntimeModels();
  const enabledIds = new Set(
    models
      .filter((model) => model.enabled && !model.catalogDeleted)
      .map((model) => model.id)
  );
  return Array.from(new Set(modelIds))
    .filter((modelId) => enabledIds.has(modelId))
    .slice(0, maximum);
}

export function modelRegistryCreateData(
  model: AiModel,
  actor: { id?: string | null; email?: string | null }
): Prisma.ModelRegistryEntryCreateInput {
  const providerConfiguration = PROVIDER_API_CONFIGURATION[model.provider];
  return {
    id: model.id,
    name: model.name,
    apiModel: model.apiModel,
    provider: model.provider,
    apiBaseUrl: providerConfiguration.baseUrl,
    apiKeyEnvName: providerConfiguration.apiKeyEnvName,
    icon: model.icon,
    bestFor: model.bestFor,
    minimumPlan: model.minimumPlan,
    usageClass: model.usageClass,
    creditWeight: getModelUsageProfile(model).credits,
    publiclyListed: model.publiclyListed !== false,
    enabled: model.enabled,
    status: model.status,
    operationalReason: model.operationalReason,
    userVisibleNote: model.userVisibleNote,
    replacementModelId: model.replacementModelId,
    catalogDeleted: model.catalogDeleted === true,
    reasoning: model.reasoning,
    contextWindowTokens: model.contextWindowTokens,
    supportsImage: model.inputCapabilities?.image === true,
    supportsNativePdf: model.inputCapabilities?.nativePdf === true,
    maxImages: model.inputCapabilities?.maxImages,
    maxBase64ImagePayloadBytes:
      model.inputCapabilities?.maxBase64ImagePayloadBytes,
    maxOutputTokens: model.maxOutputTokens,
    reservationOutputTokens: model.reservationOutputTokens,
    inputUsdPerMillionTokens: model.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: model.outputUsdPerMillionTokens,
    cachedInputPriceMultiplier: model.cachedInputPriceMultiplier,
    sortOrder: model.sortOrder || 0,
    updatedById: actor.id || undefined,
    updatedByEmail: actor.email || undefined,
  };
}

export function modelRegistryEnvironmentStatus(model: AiModel) {
  const apiKeyEnvName = PROVIDER_API_CONFIGURATION[model.provider].apiKeyEnvName;
  return {
    apiKeyEnvName,
    apiKeyConfigured: Boolean(process.env[apiKeyEnvName]?.trim()),
    protocol: PROVIDER_API_CONFIGURATION[model.provider].protocol,
  };
}

export type ModelRegistrySecurityFinding = {
  id: string;
  provider: string;
  issue: "unsupported_provider" | "api_base_url_mismatch" | "api_key_env_mismatch";
  configuredValue: string;
  expectedValue: string | null;
};

export async function getModelRegistrySecurityFindings(): Promise<
  ModelRegistrySecurityFinding[]
> {
  if (E2E_DATABASE_DISABLED()) return [];
  const rows = await prisma.modelRegistryEntry.findMany({
    select: {
      id: true,
      provider: true,
      apiBaseUrl: true,
      apiKeyEnvName: true,
    },
    orderBy: { id: "asc" },
  });

  return rows.flatMap((row) => {
    if (!isAiProvider(row.provider)) {
      return [{
        id: row.id,
        provider: row.provider,
        issue: "unsupported_provider" as const,
        configuredValue: row.provider,
        expectedValue: null,
      }];
    }

    const expected = PROVIDER_API_CONFIGURATION[row.provider];
    const findings: ModelRegistrySecurityFinding[] = [];
    if (!isApprovedProviderApiBaseUrl(row.provider, row.apiBaseUrl)) {
      findings.push({
        id: row.id,
        provider: row.provider,
        issue: "api_base_url_mismatch",
        configuredValue: row.apiBaseUrl,
        expectedValue: expected.baseUrl,
      });
    }
    if (!isApprovedProviderApiKeyEnvName(row.provider, row.apiKeyEnvName)) {
      findings.push({
        id: row.id,
        provider: row.provider,
        issue: "api_key_env_mismatch",
        configuredValue: row.apiKeyEnvName,
        expectedValue: expected.apiKeyEnvName,
      });
    }
    return findings;
  });
}
