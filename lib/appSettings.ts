import "server-only";

import { APP_DEFAULTS, guestDefaultLeadRejection } from "@/lib/appDefaults";
import {
  ASSISTANT_KNOWLEDGE_FLAG_KEY,
  ASSISTANT_PROFILES_FLAG_KEY,
  assistantKnowledgeEnabledFromValue,
  assistantKnowledgeUsable,
  assistantProfilesEnabledFromValue,
} from "@/lib/assistantProfileAccess";
import {
  isE2EAssistantKnowledgeEnabled,
  isE2EDatabaseDisabled,
} from "@/lib/e2eTestMode";
import {
  EXTERNAL_IMPORT_FLAG_KEY,
  externalImportEnabledFromValue,
} from "@/lib/externalImportAccess";
import {
  ASSISTANT_PACKAGE_IMPORT_FLAG_KEY,
  assistantPackageImportEnabledFromValue,
} from "@/lib/assistantPackageImportAccess";
import {
  IMAGE_GENERATION_FLAG_KEY,
  imageGenerationEnabledFromValue,
} from "@/lib/imageGenerationAccess";
import {
  EMAIL_CAMPAIGNS_FLAG_KEY,
  EMAIL_CONSENT_RECONFIRM_FLAG_KEY,
  EMAIL_MARKETING_FLAG_KEY,
  emailFeatureEnabledFromValue,
} from "@/lib/emailFeatureFlags";
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
import {
  invalidatePublicSnapshot,
  readPublicSnapshot,
} from "@/lib/publicSnapshotCache";

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

/**
 * The same answer, from the shared snapshot.
 *
 * Every chat turn needs this flag now: it decides what the image-capability
 * system block tells the model (lib/imageCapabilityPrompt.ts). Reading the row
 * per turn would add a database round trip to the hottest path in the app for
 * a value that changes when an operator flips a toggle.
 *
 * Its own snapshot key rather than a field on `PublicAppSettings`, for two
 * reasons: that object is what the unauthenticated `/api/app-settings`
 * serves, and this is beta rollout state; and the flag is **default-off**
 * while every flag in that object is default-on. The interpretation stays
 * `imageGenerationEnabledFromValue` here -- reusing `enabledFromValue` would
 * turn a missing row into an enabled feature, which is the precise direction
 * this flag exists to refuse.
 *
 * `setImageGenerationEnabled` invalidates the key, so an admin toggle is not
 * announced for another TTL after it is turned off.
 */
export async function isImageGenerationEnabledCached(): Promise<boolean> {
  if (e2eDatabaseDisabled()) return false;
  const { value } = await readPublicSnapshot(
    "image-generation-flag",
    isImageGenerationEnabled
  );
  return value;
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
  // Same reason `updateGuestDefaultModel` invalidates its snapshot: chat turns
  // read this flag through `isImageGenerationEnabledCached`, so without this an
  // operator who turns image generation off keeps having it announced to models
  // -- and users pointed at it -- for the rest of the TTL.
  invalidatePublicSnapshot("image-generation-flag");
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

/**
 * The email ADR's three flags (docs/policy/email-notifications.md §15.2),
 * read the same way as the two above.
 *
 * `e2eDatabaseDisabled()` returns false for the same reason it does there: a
 * harness with no database must not be able to send marketing, and off is the
 * answer that fails safely.
 */
export async function isEmailMarketingEnabled(): Promise<boolean> {
  if (e2eDatabaseDisabled()) return false;
  const row = await prisma.appSetting.findUnique({
    where: { key: EMAIL_MARKETING_FLAG_KEY },
    select: { value: true },
  });
  return emailFeatureEnabledFromValue(row?.value);
}

export async function isEmailCampaignsEnabled(): Promise<boolean> {
  if (e2eDatabaseDisabled()) return false;
  const row = await prisma.appSetting.findUnique({
    where: { key: EMAIL_CAMPAIGNS_FLAG_KEY },
    select: { value: true },
  });
  return emailFeatureEnabledFromValue(row?.value);
}

/**
 * Read by nothing today: the two-year consent re-confirmation batch does not
 * exist. Exported anyway so the ADR's name resolves to a real accessor rather
 * than to a search with no results, which is the EM-05 finding.
 */
export async function isEmailConsentReconfirmEnabled(): Promise<boolean> {
  if (e2eDatabaseDisabled()) return false;
  const row = await prisma.appSetting.findUnique({
    where: { key: EMAIL_CONSENT_RECONFIRM_FLAG_KEY },
    select: { value: true },
  });
  return emailFeatureEnabledFromValue(row?.value);
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

// Release C rollout flags (import/memory policy §15): the same default-off
// opt-in shape. Knowledge is gated on profiles as well as on itself --
// `assistantKnowledgeUsable()` says why.
export async function isAssistantProfilesEnabled(): Promise<boolean> {
  if (e2eDatabaseDisabled()) return false;
  const row = await prisma.appSetting.findUnique({
    where: { key: ASSISTANT_PROFILES_FLAG_KEY },
    select: { value: true },
  });
  return assistantProfilesEnabledFromValue(row?.value);
}

export async function isAssistantKnowledgeEnabled(): Promise<boolean> {
  // Before the database short-circuit, not after it. The flag lives in
  // `AppSetting`, so with no database there is no row and the honest answer is
  // `false` -- which is why every Playwright run rendered no knowledge panel
  // and seven specs asserted against something that was not there. The
  // override is checked first so the fixture server can say otherwise, and it
  // carries its own loopback-and-fixture guard rather than reading the
  // variable here (lib/e2eTestMode.ts).
  if (isE2EAssistantKnowledgeEnabled()) return true;
  if (e2eDatabaseDisabled()) return false;
  const [profiles, knowledge] = await Promise.all([
    isAssistantProfilesEnabled(),
    prisma.appSetting
      .findUnique({
        where: { key: ASSISTANT_KNOWLEDGE_FLAG_KEY },
        select: { value: true },
      })
      .then((row) => assistantKnowledgeEnabledFromValue(row?.value)),
  ]);
  return assistantKnowledgeUsable({
    profilesEnabled: profiles,
    knowledgeEnabled: knowledge,
  });
}

// The admin write paths, mirroring setExternalImportEnabled. Unlike the two
// Release B flags, these are ordinary rollout switches: §15 gates them on an
// activation order, not on the §12.4 human eval procedure, so there is nothing
// a screen could skip past. Separate setters rather than one, because §15
// enables them separately and in order.
export async function setAssistantProfilesEnabled(enabled: boolean) {
  await prisma.appSetting.upsert({
    where: { key: ASSISTANT_PROFILES_FLAG_KEY },
    update: { value: enabled ? "true" : "false" },
    create: {
      key: ASSISTANT_PROFILES_FLAG_KEY,
      value: enabled ? "true" : "false",
    },
  });
}

export async function setAssistantKnowledgeEnabled(enabled: boolean) {
  await prisma.appSetting.upsert({
    where: { key: ASSISTANT_KNOWLEDGE_FLAG_KEY },
    update: { value: enabled ? "true" : "false" },
    create: {
      key: ASSISTANT_KNOWLEDGE_FLAG_KEY,
      value: enabled ? "true" : "false",
    },
  });
}

export class AssistantProfilesDisabledError extends Error {
  constructor() {
    super("Assistant profiles are not enabled.");
    this.name = "AssistantProfilesDisabledError";
  }
}

export async function assertAssistantProfilesEnabled() {
  if (!(await isAssistantProfilesEnabled())) {
    throw new AssistantProfilesDisabledError();
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

/**
 * The assistant-package import rollout flag
 * (docs/policy/assistant-package-import.md §11).
 *
 * Same default-off opt-in shape as the flags above. The wizard route is the
 * only reader today, and it answers 404 rather than rendering a disabled
 * screen: a route that exists and refuses still tells anyone who asks that the
 * feature is coming, and there is nothing here for an operator to act on.
 */
export async function isAssistantPackageImportEnabled(): Promise<boolean> {
  if (e2eDatabaseDisabled()) return false;
  const row = await prisma.appSetting.findUnique({
    where: { key: ASSISTANT_PACKAGE_IMPORT_FLAG_KEY },
    select: { value: true },
  });
  return assistantPackageImportEnabledFromValue(row?.value);
}
