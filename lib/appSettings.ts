import "server-only";

import { APP_DEFAULTS, guestDefaultLeadRejection } from "@/lib/appDefaults";
import { isE2EDatabaseDisabled } from "@/lib/e2eTestMode";
import {
  EXTERNAL_IMPORT_FLAG_KEY,
  externalImportEnabledFromValue,
} from "@/lib/externalImportAccess";
import {
  IMAGE_GENERATION_FLAG_KEY,
  imageGenerationEnabledFromValue,
} from "@/lib/imageGenerationAccess";
import {
  MEMORY_EXTRACTION_FLAG_KEY,
  MEMORY_EXTRACTION_REVOKED_PAIRS_KEY,
  MEMORY_INJECTION_FLAG_KEY,
  memoryExtractionEnabledFromValue,
  memoryInjectionEnabledFromValue,
  parseRevokedPairs,
  revokedPairsRequestProblems,
  serializeRevokedPairs,
  type RevokedPairsRequest,
  type RevokedPairsState,
} from "@/lib/memoryAccess";
import {
  canUseModelWithPlan,
  getModelUsageProfile,
} from "@/lib/models";
import { getEnabledRuntimeModel } from "@/lib/modelRegistry";
import { prisma } from "@/lib/prisma";
import { invalidatePublicSnapshot } from "@/lib/publicSnapshotCache";

export type PublicAppSettings = {
  guestDefaultModelId: string;
  aiChatEnabled: boolean;
  attachmentsEnabled: boolean;
  publicSharingEnabled: boolean;
};

const GUEST_DEFAULT_MODEL_KEY = "guestDefaultModelId";
const OPERATIONAL_FLAG_KEYS = {
  aiChatEnabled: "feature.aiChatEnabled",
  attachmentsEnabled: "feature.attachmentsEnabled",
  publicSharingEnabled: "feature.publicSharingEnabled",
} as const;

export type OperationalFeatureFlags = Pick<
  PublicAppSettings,
  "aiChatEnabled" | "attachmentsEnabled" | "publicSharingEnabled"
>;

const enabledFromValue = (value: string | null | undefined) => value !== "false";
const e2eDatabaseDisabled = isE2EDatabaseDisabled;

/**
 * Why a value may not be stored here. The rule itself lives in
 * `guestDefaultLeadRejection` (pure, so it can be tested without a database);
 * this resolves the model against the runtime registry and applies it.
 *
 * The part worth knowing: eligibility is not enough. This setting only
 * reorders the guest brand trio, so a model outside it saves cleanly, reads
 * back, is served by `/api/app-settings`, and changes nothing a guest ever
 * sees. That is rejected rather than accepted.
 */
export const guestDefaultModelRejection = async (
  modelId: string
): Promise<string | null> => {
  const model = await getEnabledRuntimeModel(modelId);
  return guestDefaultLeadRejection({
    modelId,
    exists: Boolean(model),
    guestEligible: Boolean(model && canUseModelWithPlan("Guest", model)),
    usageCategory: model ? getModelUsageProfile(model).category : null,
  });
};

export const isValidGuestDefaultModel = async (modelId: string) =>
  (await guestDefaultModelRejection(modelId)) === null;

const normalizeGuestDefaultModel = async (modelId: string | null | undefined) =>
  modelId && (await isValidGuestDefaultModel(modelId))
    ? modelId
    : APP_DEFAULTS.guestDefaultModelId;

export async function getPublicAppSettings(): Promise<PublicAppSettings> {
  if (e2eDatabaseDisabled()) {
    return {
      guestDefaultModelId: APP_DEFAULTS.guestDefaultModelId,
      aiChatEnabled: true,
      attachmentsEnabled: true,
      publicSharingEnabled: true,
    };
  }
  const rows = await prisma.appSetting.findMany({
    where: {
      key: { in: [GUEST_DEFAULT_MODEL_KEY, ...Object.values(OPERATIONAL_FLAG_KEYS)] },
    },
    select: { key: true, value: true },
  });
  const values = new Map(rows.map((row) => [row.key, row.value]));

  return {
    guestDefaultModelId: await normalizeGuestDefaultModel(
      values.get(GUEST_DEFAULT_MODEL_KEY)
    ),
    aiChatEnabled: enabledFromValue(values.get(OPERATIONAL_FLAG_KEYS.aiChatEnabled)),
    attachmentsEnabled: enabledFromValue(
      values.get(OPERATIONAL_FLAG_KEYS.attachmentsEnabled)
    ),
    publicSharingEnabled: enabledFromValue(
      values.get(OPERATIONAL_FLAG_KEYS.publicSharingEnabled)
    ),
  };
}

export async function getOperationalFeatureFlags(): Promise<OperationalFeatureFlags> {
  const settings = await getPublicAppSettings();
  return {
    aiChatEnabled: settings.aiChatEnabled,
    attachmentsEnabled: settings.attachmentsEnabled,
    publicSharingEnabled: settings.publicSharingEnabled,
  };
}

export async function updateGuestDefaultModel(modelId: string) {
  if (e2eDatabaseDisabled()) return normalizeGuestDefaultModel(modelId);
  const rejection = await guestDefaultModelRejection(modelId);
  if (rejection) throw new Error(`Guest default model rejected: ${rejection}`);
  const normalized = modelId;

  await prisma.appSetting.upsert({
    where: { key: GUEST_DEFAULT_MODEL_KEY },
    create: {
      key: GUEST_DEFAULT_MODEL_KEY,
      value: modelId,
    },
    update: {
      value: modelId,
    },
  });
  // SEC-012. `/api/app-settings` answers from a shared snapshot; without this
  // the console would show its own change as unapplied until the TTL lapsed.
  invalidatePublicSnapshot("app-settings");

  return normalized;
}

export async function updatePublicAppSettings(settings: PublicAppSettings) {
  if (e2eDatabaseDisabled()) return settings;
  const rejection = await guestDefaultModelRejection(
    settings.guestDefaultModelId
  );
  if (rejection) throw new Error(`Guest default model rejected: ${rejection}`);
  const guestDefaultModelId = settings.guestDefaultModelId;
  await prisma.$transaction(
    [
      [GUEST_DEFAULT_MODEL_KEY, guestDefaultModelId],
      [OPERATIONAL_FLAG_KEYS.aiChatEnabled, String(settings.aiChatEnabled)],
      [OPERATIONAL_FLAG_KEYS.attachmentsEnabled, String(settings.attachmentsEnabled)],
      [OPERATIONAL_FLAG_KEYS.publicSharingEnabled, String(settings.publicSharingEnabled)],
    ].map(([key, value]) =>
      prisma.appSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      })
    )
  );
  invalidatePublicSnapshot("app-settings");
  return getPublicAppSettings();
}

// Image generation is deliberately NOT part of OPERATIONAL_FLAG_KEYS /
// PublicAppSettings. Those flags are default-on kill switches
// (`enabledFromValue`: anything but "false" is enabled); a beta feature needs
// the opposite -- default-off, enabled only by an explicit opt-in row. The
// pure semantics live in lib/imageGenerationAccess.ts so tests cover them
// without a database. Admin surfacing is the dedicated toggle in the admin
// platform settings (setImageGenerationEnabled below); public surfacing is
// the chat page resolving the flag server-side into its RSC payload.
export async function isImageGenerationEnabled(): Promise<boolean> {
  if (e2eDatabaseDisabled()) return false;
  const row = await prisma.appSetting.findUnique({
    where: { key: IMAGE_GENERATION_FLAG_KEY },
    select: { value: true },
  });
  return imageGenerationEnabledFromValue(row?.value);
}

// The admin write path. "true"/"false" are the only stored values; a missing
// row and "false" are equally off (imageGenerationEnabledFromValue), so
// disabling never needs a delete.
export async function setImageGenerationEnabled(enabled: boolean) {
  await prisma.appSetting.upsert({
    where: { key: IMAGE_GENERATION_FLAG_KEY },
    update: { value: enabled ? "true" : "false" },
    create: { key: IMAGE_GENERATION_FLAG_KEY, value: enabled ? "true" : "false" },
  });
}

export class ImageGenerationDisabledError extends Error {
  constructor() {
    super("Image generation is not enabled.");
    this.name = "ImageGenerationDisabledError";
  }
}

export async function assertImageGenerationEnabled() {
  if (!(await isImageGenerationEnabled())) {
    throw new ImageGenerationDisabledError();
  }
}

// Same default-off opt-in shape as image generation above, for the same
// reason: a rollout flag must fail closed when the row is missing
// (docs/policy/external-conversation-import-and-memory.md §15). Admin
// surfacing is the platform-settings toggle (setExternalImportEnabled
// below); the import UI resolves availability through the flag-gated
// capacity endpoint rather than a public settings field.
export async function isExternalImportEnabled(): Promise<boolean> {
  if (e2eDatabaseDisabled()) return false;
  const row = await prisma.appSetting.findUnique({
    where: { key: EXTERNAL_IMPORT_FLAG_KEY },
    select: { value: true },
  });
  return externalImportEnabledFromValue(row?.value);
}

// The admin write path, mirroring setImageGenerationEnabled: "true"/"false"
// are the only stored values, and a missing row equals "false", so disabling
// never needs a delete.
export async function setExternalImportEnabled(enabled: boolean) {
  await prisma.appSetting.upsert({
    where: { key: EXTERNAL_IMPORT_FLAG_KEY },
    update: { value: enabled ? "true" : "false" },
    create: {
      key: EXTERNAL_IMPORT_FLAG_KEY,
      value: enabled ? "true" : "false",
    },
  });
}

export class ExternalImportDisabledError extends Error {
  constructor() {
    super("External conversation import is not enabled.");
    this.name = "ExternalImportDisabledError";
  }
}

export async function assertExternalImportEnabled() {
  if (!(await isExternalImportEnabled())) {
    throw new ExternalImportDisabledError();
  }
}

// Release B rollout flags (import/memory policy §15): the same default-off
// opt-in shape as the two flags above.
export async function isMemoryExtractionEnabled(): Promise<boolean> {
  if (e2eDatabaseDisabled()) return false;
  const row = await prisma.appSetting.findUnique({
    where: { key: MEMORY_EXTRACTION_FLAG_KEY },
    select: { value: true },
  });
  return memoryExtractionEnabledFromValue(row?.value);
}

/**
 * §15 injection flag. Read by the chat context builder and by nothing else —
 * it is what decides whether an approved memory may reach a prompt at all.
 *
 * It is still off, and turning it on is a human procedure, not a code change:
 * §12.4 requires a decision-grade eval, blind review, an independent re-run,
 * a signed approval and a staging verification first. The wiring exists ahead
 * of that on purpose, so the day it is turned on is a settings change against
 * a path that has already been reviewed and tested — not a deploy.
 */
export async function isMemoryInjectionEnabled(): Promise<boolean> {
  if (e2eDatabaseDisabled()) return false;
  const row = await prisma.appSetting.findUnique({
    where: { key: MEMORY_INJECTION_FLAG_KEY },
    select: { value: true },
  });
  return memoryInjectionEnabledFromValue(row?.value);
}

export class MemoryFeatureDisabledError extends Error {
  constructor() {
    super("Account memory is not enabled.");
    this.name = "MemoryFeatureDisabledError";
  }
}

export async function assertMemoryExtractionEnabled() {
  if (!(await isMemoryExtractionEnabled())) {
    throw new MemoryFeatureDisabledError();
  }
}

/**
 * Operational pair revocation (§12.1): reads
 * AppSetting["memoryExtractionRevokedPairs"]. Malformed content reads as
 * revoke-all — see lib/memoryAccess.ts for why that direction is the safe
 * one.
 */
export async function getMemoryExtractionRevokedPairs(): Promise<RevokedPairsState> {
  if (e2eDatabaseDisabled()) return { kind: "none" };
  const row = await prisma.appSetting.findUnique({
    where: { key: MEMORY_EXTRACTION_REVOKED_PAIRS_KEY },
    select: { value: true },
  });
  return parseRevokedPairs(row?.value);
}

/**
 * The §12.1 emergency revocation write path.
 *
 * The policy says this is changed "by an approved operator in the Admin
 * Console, audit-logged, immediately fail-closed". Everything but the write
 * existed: the read, the parser and the extraction-side check were all
 * wired, and the only way to actually revoke a pair was a hand-typed
 * `UPDATE` against production -- with no permission check, no audit record,
 * and a format where one typo silently means "revoke everything" rather than
 * "revoke this pair".
 *
 * The stored value is re-parsed and returned rather than echoed, so the
 * caller sees the state the next extraction will read rather than the state
 * it asked for. `serializeRevokedPairs` and `parseRevokedPairs` round-trip,
 * so those agree -- and the day they do not, this is where it shows.
 */
export async function setMemoryExtractionRevokedPairs(
  request: RevokedPairsRequest
): Promise<RevokedPairsState> {
  const problems = revokedPairsRequestProblems(request);
  if (problems.length > 0) {
    throw new MemoryRevocationRequestError(problems);
  }
  const value = serializeRevokedPairs(request);
  await prisma.appSetting.upsert({
    where: { key: MEMORY_EXTRACTION_REVOKED_PAIRS_KEY },
    update: { value },
    create: { key: MEMORY_EXTRACTION_REVOKED_PAIRS_KEY, value },
  });
  return parseRevokedPairs(value);
}

export class MemoryRevocationRequestError extends Error {
  constructor(public readonly problems: string[]) {
    super("The revocation request cannot be stored as written.");
    this.name = "MemoryRevocationRequestError";
  }
}

export class OperationalFeatureDisabledError extends Error {
  constructor(public feature: keyof OperationalFeatureFlags) {
    super(`The ${feature} feature is temporarily disabled by an administrator.`);
    this.name = "OperationalFeatureDisabledError";
  }
}

export async function assertOperationalFeatureEnabled(
  feature: keyof OperationalFeatureFlags
) {
  const flags = await getOperationalFeatureFlags();
  if (!flags[feature]) throw new OperationalFeatureDisabledError(feature);
}
