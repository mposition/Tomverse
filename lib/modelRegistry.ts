import "server-only";

import type { ModelRegistryEntry, Prisma } from "@prisma/client";
import { isMissingDatabaseSchemaError } from "@/lib/databaseError";
import { prisma } from "@/lib/prisma";
import {
  AVAILABLE_MODELS,
  getModelBillingProfile,
  getModelUsageProfile,
  type AiModel,
  type ModelInputCapabilities,
  type ModelMinimumPlan,
  type ModelStatus,
  type ModelUsageClass,
} from "@/lib/models";
import {
  PROVIDER_API_CONFIGURATION,
  isAiProvider,
  isSafeProviderApiBaseUrl,
  normalizeApiBaseUrl,
} from "@/lib/modelRegistryShared";

const E2E_DATABASE_DISABLED = process.env.E2E_DISABLE_DATABASE === "true";

const staticModelWithRuntimeDefaults = (
  model: AiModel,
  sortOrder: number
): AiModel => {
  const providerConfig = PROVIDER_API_CONFIGURATION[model.provider];
  const billing = getModelBillingProfile(model);
  return {
    ...model,
    apiBaseUrl: model.apiBaseUrl || providerConfig.baseUrl,
    apiKeyEnvName: model.apiKeyEnvName || providerConfig.apiKeyEnvName,
    creditWeight: getModelUsageProfile(model).credits,
    catalogDeleted: false,
    sortOrder,
    ...billing,
  };
};

const STATIC_RUNTIME_MODELS = AVAILABLE_MODELS.map(staticModelWithRuntimeDefaults);

const staticSeedRows = () =>
  STATIC_RUNTIME_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    apiModel: model.apiModel,
    provider: model.provider,
    apiBaseUrl: model.apiBaseUrl!,
    apiKeyEnvName: model.apiKeyEnvName!,
    icon: model.icon,
    bestFor: model.bestFor,
    minimumPlan: model.minimumPlan,
    usageClass: model.usageClass,
    creditWeight: model.creditWeight!,
    publiclyListed: model.publiclyListed !== false,
    enabled: model.enabled,
    status: model.status,
    operationalReason: model.operationalReason || null,
    userVisibleNote: model.userVisibleNote || null,
    replacementModelId: model.replacementModelId || null,
    catalogDeleted: false,
    reasoning: model.reasoning || null,
    contextWindowTokens: model.contextWindowTokens || null,
    supportsImage: model.inputCapabilities?.image === true,
    supportsNativePdf: model.inputCapabilities?.nativePdf === true,
    maxImages: model.inputCapabilities?.maxImages || null,
    maxBase64ImagePayloadBytes:
      model.inputCapabilities?.maxBase64ImagePayloadBytes || null,
    maxOutputTokens: model.maxOutputTokens || null,
    reservationOutputTokens: model.reservationOutputTokens || null,
    inputUsdPerMillionTokens: model.inputUsdPerMillionTokens ?? null,
    outputUsdPerMillionTokens: model.outputUsdPerMillionTokens ?? null,
    cachedInputPriceMultiplier: model.cachedInputPriceMultiplier ?? null,
    sortOrder: model.sortOrder || 0,
  }));

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
  if (!isSafeProviderApiBaseUrl(row.apiBaseUrl)) {
    throw new Error(`Model registry entry ${row.id} has an unsafe API Base URL.`);
  }
  return {
    id: row.id,
    name: row.name,
    apiModel: row.apiModel,
    provider: row.provider,
    apiBaseUrl: normalizeApiBaseUrl(row.apiBaseUrl),
    apiKeyEnvName: row.apiKeyEnvName,
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

export async function ensureModelRegistrySeeded() {
  if (E2E_DATABASE_DISABLED) return;
  if (!bootstrapPromise) {
    bootstrapPromise = prisma.modelRegistryEntry
      .createMany({ data: staticSeedRows(), skipDuplicates: true })
      .then(() => undefined)
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
  if (E2E_DATABASE_DISABLED) {
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
  return {
    id: model.id,
    name: model.name,
    apiModel: model.apiModel,
    provider: model.provider,
    apiBaseUrl:
      model.apiBaseUrl || PROVIDER_API_CONFIGURATION[model.provider].baseUrl,
    apiKeyEnvName:
      model.apiKeyEnvName ||
      PROVIDER_API_CONFIGURATION[model.provider].apiKeyEnvName,
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
  const apiKeyEnvName =
    model.apiKeyEnvName ||
    PROVIDER_API_CONFIGURATION[model.provider].apiKeyEnvName;
  return {
    apiKeyEnvName,
    apiKeyConfigured: Boolean(process.env[apiKeyEnvName]?.trim()),
    protocol: PROVIDER_API_CONFIGURATION[model.provider].protocol,
  };
}
