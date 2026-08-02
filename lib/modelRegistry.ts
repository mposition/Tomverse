import "server-only";

import type { ModelRegistryEntry, Prisma } from "@prisma/client";
import { isMissingDatabaseSchemaError } from "@/lib/databaseError";
import { isE2EDatabaseDisabled } from "@/lib/e2eTestMode";
import { prisma } from "@/lib/prisma";
import {
  getModelUsageProfile,
  isWithdrawnFromOfferModel,
  resolveSelectableModelId,
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
  staticModelRegistryReconciliationRows,
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

// Withdrawing a model from the offer is a deliberate, human-authored
// lifecycle decision -- a provider stopped serving it, or it has not cleared
// its launch gate -- unlike the tunable fields (name, blurb, pricing, sort
// order) that an admin may legitimately diverge from the bootstrap catalog on.
const STATIC_WITHDRAWN_MODELS = STATIC_RUNTIME_MODELS.filter(
    isWithdrawnFromOfferModel
);

// `createMany({ skipDuplicates: true })` only ever inserts, so a model that
// was already in the runtime registry before it was retired in
// `lib/models.ts` kept its old `enabled`/`publiclyListed`/`status` values
// forever -- the public model API and the picker went on offering a model no
// provider would serve. The withdrawal is therefore replayed onto existing
// rows on every bootstrap.
//
// This covers pre-launch models as well as retired ones, because the failure
// is identical from the row's point of view: a build that had the model
// enabled reaching an environment before the build that withdrew it leaves an
// enabled row nothing would ever correct. Each model's own `status` is
// written, so a retirement lands as "disabled" and a withheld launch as
// "coming-soon" rather than being flattened together. `catalogDeleted` is
// deliberately untouched: it stays human-controlled.
/**
 * Forces every model the checked-in catalogue has withdrawn back into its
 * withdrawn state on the runtime registry. Exported as well as called from the
 * bootstrap so it can be invoked deliberately -- by a test, or by an operator
 * reconciling an environment -- rather than only as a side effect of the first
 * request after a deploy. Safe to run repeatedly: it writes only rows that
 * differ, and never touches catalogDeleted or any admin-tunable field.
 */
export async function reconcileStaticWithdrawals() {
  if (STATIC_WITHDRAWN_MODELS.length === 0) return;

  const withdrawnIds = STATIC_WITHDRAWN_MODELS.map((model) => model.id);
  // Read first, then write only the rows that actually differ. The previous
  // version expressed "needs correcting" as a WHERE clause
  // (enabled OR publiclyListed OR status mismatch) and so could not see a row
  // that was ALREADY withdrawn but pointed at the wrong replacement -- exactly
  // the shape llama-4-scout was in when llama-3-3 was retired underneath it:
  // disabled, delisted, correct status, and handing users a model that no
  // longer exists. Comparing values instead of guessing at a predicate also
  // keeps this idempotent without relying on Prisma's null-vs-`not` filter
  // semantics, which differ by field nullability.
  const rows = await prisma.modelRegistryEntry.findMany({
    where: { id: { in: withdrawnIds } },
    select: {
      id: true,
      enabled: true,
      publiclyListed: true,
      status: true,
      replacementModelId: true,
    },
  });
  const rowsById = new Map(rows.map((row) => [row.id, row]));

  for (const model of STATIC_WITHDRAWN_MODELS) {
    const row = rowsById.get(model.id);
    // Not seeded yet: createMany above will have inserted it in the correct
    // state, or it is genuinely absent. Either way there is nothing to fix.
    if (!row) continue;

    const intendedReplacement = model.replacementModelId ?? null;
    const isCurrent =
      row.enabled === false &&
      row.publiclyListed === false &&
      row.status === model.status &&
      // Only asserted when the catalogue names one. A withdrawal with no
      // replacement (a pre-launch model) must not blank out a replacement an
      // operator set by hand.
      (intendedReplacement === null ||
        row.replacementModelId === intendedReplacement);
    if (isCurrent) continue;

    await prisma.modelRegistryEntry.update({
      where: { id: model.id },
      data: {
        enabled: false,
        publiclyListed: false,
        status: model.status,
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

    // console.info, not warn.
    //
    // This is a successful reconciliation reporting what it changed, and it
    // runs on every deploy that withdraws a model. On stderr the collector
    // files it as severity=error, so a normal release fills the error stream
    // with entries that need no action -- which is how a real error stops
    // being noticed. Structured so the fields can be queried rather than
    // grepped out of an interpolated sentence.
    console.info(
      JSON.stringify({
        event: "model_registry.static_withdrawal_applied",
        severity: "info",
        modelId: model.id,
        status: model.status,
        replacementModelId: intendedReplacement,
        changedFields: {
          enabled: { from: row.enabled, to: false },
          publiclyListed: { from: row.publiclyListed, to: false },
          status: { from: row.status, to: model.status },
          replacementModelId: {
            from: row.replacementModelId,
            to: intendedReplacement,
          },
        },
      })
    );
  }
}

// Exact-ID reconciliation for the 2026-08-01 provider catalogue migration.
// Unlike createMany(skipDuplicates), this updates the upstream ID, display
// metadata, capability and pricing fields of existing rows. It deliberately
// excludes catalogDeleted, sortOrder, provider connection settings, actor
// metadata and active-model lifecycle fields so an operator's incident switch
// is never turned back on by an application restart.
async function applyScopedStaticCatalogReconciliation() {
  const changes = staticModelRegistryReconciliationRows();
  if (changes.length === 0) return;

  const existingRows = await prisma.modelRegistryEntry.findMany({
    where: { id: { in: changes.map((change) => change.id) } },
  });
  const existingById = new Map(existingRows.map((row) => [row.id, row]));

  for (const change of changes) {
    const current = existingById.get(change.id);
    if (!current) continue;
    const hasDrift = Object.entries(change.data).some(
      ([field, value]) =>
        current[field as keyof ModelRegistryEntry] !== value
    );
    if (!hasDrift) continue;

    await prisma.modelRegistryEntry.update({
      where: { id: change.id },
      data: change.data as Prisma.ModelRegistryEntryUpdateInput,
    });
    console.info(
      JSON.stringify({
        event: "model_registry.static_metadata_reconciled",
        severity: "info",
        modelId: change.id,
        changedFields: Object.keys(change.data),
      })
    );
  }
}

export async function ensureModelRegistrySeeded() {
  if (E2E_DATABASE_DISABLED()) return;
  if (!bootstrapPromise) {
    bootstrapPromise = prisma.modelRegistryEntry
      .createMany({
        data: staticModelRegistrySeedRows(),
        skipDuplicates: true,
      })
      .then(async () => {
        await reconcileStaticWithdrawals();
        await applyScopedStaticCatalogReconciliation();
      })
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

export function clampSelectedModelsAgainstRuntime(
  modelIds: string[],
  models: readonly AiModel[],
  maximum = 3
) {
  const modelMap = new Map(models.map((model) => [model.id, model]));
  return Array.from(new Set(modelIds))
    .map((modelId) =>
      resolveSelectableModelId(modelId, (candidateId) => modelMap.get(candidateId))
    )
    .filter((modelId): modelId is string => Boolean(modelId))
    .filter((modelId, index, resolved) => resolved.indexOf(modelId) === index)
    .slice(0, maximum);
}

export async function clampRuntimeSelectedModels(
  modelIds: string[],
  maximum = 3
) {
  const models = await getRuntimeModels();
  return clampSelectedModelsAgainstRuntime(modelIds, models, maximum);
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
