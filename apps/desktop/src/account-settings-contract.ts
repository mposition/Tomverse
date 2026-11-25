import { z } from "zod";
import { SUPPORTED_LANGUAGES } from "../../../lib/language";
import { isValidIanaTimeZone } from "../../../lib/userTimeZone";
import { ASSISTANT_PROFILE_LIMITS } from "../../../lib/assistantProfileVersioning";
import { ASSISTANT_KNOWLEDGE_LIMITS } from "../../../lib/assistantKnowledgeLimits";
import { EMAIL_PURPOSES } from "../../../lib/emailPreferenceCore";
import { MEMORY_KINDS } from "../../../lib/memoryValidatorCore";
import { EXTERNAL_IMPORT_PROVIDERS } from "../../../lib/externalImportProviders";
import { EXTERNAL_IMPORT_MAX_BATCH_REQUEST_BYTES, EXTERNAL_IMPORT_STORAGE_LIMITS, utf8ByteLength } from "../../../lib/externalImportLimits";

const accountId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const label = z.string().max(400);
const projectName = z.string().trim().min(1).max(32);
const project = z.object({ id: accountId, name: projectName, conversationCount: z.number().int().nonnegative() });
const importCount = z.number().int().nonnegative();
const importDigest = z.string().regex(/^[a-f0-9]{64}$/);
const importSequence = importCount.max(1_000_000);
const stagedIds = z.array(accountId).max(EXTERNAL_IMPORT_STORAGE_LIMITS.maxExternalConversationsPerAccount);
const importTimestamp = z.iso.datetime();
const importModel = z.string().trim().min(1).max(120);
const importConversation = z.object({
  rawExternalConversationId: z.string().min(1).max(512), title: z.string().trim().min(1).max(300),
  sourceModelLabels: z.array(importModel).max(10).optional(),
  sourceCreatedAt: importTimestamp.optional(), sourceUpdatedAt: importTimestamp.optional(),
  messages: z.array(z.object({
    rawExternalMessageId: z.string().min(1).max(512), role: z.enum(["user", "assistant"]),
    ordinal: importSequence, content: z.string().min(1).max(2_100_000),
    sourceModelLabel: importModel.optional(), sourceTimestamp: importTimestamp.optional(),
  }).strict()).min(1).max(2_000),
}).strict();
const importBatch = z.object({ sequence: importSequence, conversations: z.array(importConversation).min(1).max(50) }).strict()
  .refine(value => utf8ByteLength(JSON.stringify(value)) <= EXTERNAL_IMPORT_MAX_BATCH_REQUEST_BYTES);
export const accountTheme = z.enum(["dark", "light", "system"]);
const timeZone = z.string().max(100).refine(isValidIanaTimeZone);
const memoryPreferences = z.object({
  masterEnabled: z.boolean(),
  styleEnabled: z.boolean(),
  defaultConversationMode: z.enum(["on", "off"]),
}).strict();
const memorySummary = z.object({
  id: accountId, kind: z.enum(MEMORY_KINDS), statement: z.string(), status: z.string(), pinned: z.boolean(),
  expiresAt: z.string().nullable(), sensitivity: z.enum(["standard", "sensitive"]),
});
const memoryEvidence = z.object({ id: accountId, manualContent: z.string().nullable(),
  externalConversationId: accountId.nullable(), sourceTitle: z.string().nullable() });
const assistantIdentity = z.object({
  name: z.string().trim().min(1).max(ASSISTANT_PROFILE_LIMITS.maxNameCharacters),
  icon: z.string().trim().max(ASSISTANT_PROFILE_LIMITS.maxIconCharacters).nullable(),
  description: z.string().trim().max(ASSISTANT_PROFILE_LIMITS.maxDescriptionCharacters).nullable(),
}).strict();
const assistantPolicies = {
  toolPolicy: z.object({ webSearch: z.boolean(), deepResearch: z.boolean() }).strict(),
  memoryPolicy: z.object({ useAccountMemory: z.boolean() }).strict(),
};
const assistantInstructions = z.string().max(ASSISTANT_PROFILE_LIMITS.maxInstructionsCharacters);
const assistantModels = z.array(z.string().trim().min(1).max(120)).max(ASSISTANT_PROFILE_LIMITS.maxModels);
const assistantStarters = z.array(z.string().trim().max(ASSISTANT_PROFILE_LIMITS.maxStarterCharacters)).max(ASSISTANT_PROFILE_LIMITS.maxStarters);
const versionEntry = z.object({ id: accountId, revision: z.number().int().positive(), createdAt: z.string() });

export const accountPreferences = z.object({
  theme: accountTheme,
  language: z.enum(SUPPORTED_LANGUAGES),
  timeZone,
  timeZoneChangeAllowedAt: z.string().nullable(),
  newConversationModelIds: z.array(z.string()).default([]),
  imageHandoffAutoGenerate: z.boolean().optional(),
});

const emailSettings = z.object({
  preferences: z.array(z.object({
    purpose: z.enum(EMAIL_PURPOSES), enabled: z.boolean(), locked: z.boolean(),
    confirmation: z.enum(["off", "pending", "on", "unconfirmed"]).nullable().optional(),
  })),
  country: z.object({ selfDeclared: z.string().nullable() }),
});

const emailChanges = z.object({
  purpose: z.enum(EMAIL_PURPOSES).optional(), enabled: z.boolean().optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(), withdrawAllMarketing: z.literal(true).optional(),
  cancelRequestOnly: z.literal(true).optional(),
}).strict();

const savePreferences = z.object({
  theme: accountTheme.optional(),
  language: z.enum(SUPPORTED_LANGUAGES).optional(),
  timeZone: timeZone.optional(),
  newConversationModelIds: z.array(z.string().min(1).max(120)).min(1).max(3).optional(),
  imageHandoffAutoGenerate: z.boolean().optional(),
}).strict();

export const desktopAccountSettingsInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preferences") }).strict(),
  z.object({ action: z.literal("savePreferences"), changes: savePreferences }).strict(),
  z.object({ action: z.literal("loginMethods") }).strict(),
  z.object({ action: z.literal("email") }).strict(),
  z.object({ action: z.literal("saveEmail"), changes: emailChanges }).strict(),
  z.object({ action: z.literal("memory") }).strict(),
  z.object({ action: z.literal("saveMemory"), values: memoryPreferences }).strict(),
  z.object({ action: z.literal("memories"), offset: z.number().int().min(0).max(100_000) }).strict(),
  z.object({ action: z.literal("memoryDetail"), id: accountId }).strict(),
  z.object({ action: z.literal("updateMemory"), id: accountId, values: z.discriminatedUnion("action", [
    z.object({ action: z.literal("edit"), statement: z.string().trim().min(1).max(1_000) }).strict(),
    z.object({ action: z.literal("pin") }).strict(),
    z.object({ action: z.literal("unpin") }).strict(),
  ]) }).strict(),
  z.object({ action: z.literal("addMemory"), kind: z.enum(MEMORY_KINDS),
    statement: z.string().trim().min(1).max(1_000), groundsText: z.string().trim().min(1).max(2_000) }).strict(),
  z.object({ action: z.literal("assistants") }).strict(),
  z.object({ action: z.literal("assistant"), id: accountId }).strict(),
  z.object({ action: z.literal("saveAssistantIdentity"), id: accountId, values: assistantIdentity }).strict(),
  z.object({ action: z.literal("publishAssistant"), id: accountId, values: z.object({
    expectedRevision: z.number().int().positive().nullable(), instructions: assistantInstructions,
    modelIds: assistantModels, starters: assistantStarters, ...assistantPolicies,
    knowledgeFileIds: z.array(accountId).max(ASSISTANT_KNOWLEDGE_LIMITS.maxFilesPerProfile),
  }).strict() }).strict(),
  z.object({ action: z.literal("createAssistant"), name: z.string().trim().min(1).max(ASSISTANT_PROFILE_LIMITS.maxNameCharacters),
    description: z.string().trim().max(ASSISTANT_PROFILE_LIMITS.maxDescriptionCharacters).optional(),
    instructions: z.string().trim().min(1).max(ASSISTANT_PROFILE_LIMITS.maxInstructionsCharacters) }).strict(),
  z.object({ action: z.literal("imports"), offset: z.number().int().min(0).max(100_000) }).strict(),
  z.object({ action: z.literal("importRuns") }).strict(),
  z.object({ action: z.literal("importConversation"), id: accountId,
    offset: z.number().int().min(0).max(1_000_000) }).strict(),
  z.object({ action: z.literal("importCapacity") }).strict(),
  z.object({ action: z.literal("startImport"), provider: z.enum(EXTERNAL_IMPORT_PROVIDERS) }).strict(),
  z.object({ action: z.literal("importStatus"), id: accountId }).strict(),
  z.object({ action: z.literal("appendImport"), id: accountId, batch: importBatch }).strict(),
  z.object({ action: z.literal("sealImport"), id: accountId, finalSequence: importSequence,
    expectedStagedConversationIds: stagedIds, expectedDuplicateCount: importSequence }).strict(),
  z.object({ action: z.literal("finishImport"), id: accountId, selectedConversationIds: stagedIds.min(1),
    expectedImportDigest: importDigest, key: z.uuid() }).strict(),
  z.object({ action: z.literal("continueImport"), id: accountId, key: z.uuid() }).strict(),
  z.object({ action: z.literal("reviewContinuation"), id: accountId, key: z.uuid() }).strict(),
  z.object({ action: z.literal("pinConversation"), id: accountId, pinned: z.boolean(),
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), accountScope: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ action: z.literal("projects") }).strict(),
  z.object({ action: z.literal("addProject"), name: projectName }).strict(),
  z.object({ action: z.literal("renameProject"), id: accountId, name: projectName }).strict(),
  z.object({ action: z.literal("removeProject"), id: accountId }).strict(),
  z.object({ action: z.literal("moveToProject"), id: accountId, projectId: accountId.nullable() }).strict(),
  z.object({ action: z.literal("changeConversationLock"), id: accountId, values: z.union([
    z.object({ password: z.string().min(8).max(128) }).strict(),
    z.object({ password: z.null(), currentPassword: z.string().min(1).max(128) }).strict(),
  ]) }).strict(),
  z.object({ action: z.literal("shareConversation"), id: accountId }).strict(),
  z.object({ action: z.literal("revokeConversationShare"), id: accountId }).strict(),
  z.object({ action: z.literal("keys") }).strict(),
  z.object({ action: z.literal("createKey"), name: z.string().trim().min(1).max(80),
    creditCap: z.number().int().positive().nullable(), expiresInDays: z.number().int().positive().max(365).nullable() }).strict(),
  z.object({ action: z.literal("updateKey"), id: accountId, name: z.string().trim().min(1).max(80),
    creditCap: z.number().int().positive().nullable() }).strict(),
  z.object({ action: z.literal("revokeKey"), id: accountId }).strict(),
  z.object({ action: z.literal("usage") }).strict(),
  z.object({ action: z.literal("exportHistory") }).strict(),
  z.object({ action: z.literal("deleteMemory"), id: accountId }).strict(),
  z.object({ action: z.literal("moveMemoryScope"), id: accountId, expectedRevision: z.number().int().positive(),
    projectId: accountId.nullable() }).strict(),
  z.object({ action: z.literal("extractionRuns") }).strict(),
  z.object({ action: z.literal("cancelExtraction"), id: accountId }).strict(),
]);

const keySummary = z.object({
  id: accountId, name: label, keyPrefix: label, state: z.enum(["active", "expired", "revoked"]),
  expiresAt: z.string().nullable(), creditCap: z.number().int().positive().nullable(), committedCredits: z.number(),
});

const loginMethod = z.discriminatedUnion("type", [
  z.object({ type: z.literal("oauth"), provider: label, linked: z.boolean() }),
  z.object({ type: z.literal("email"), enabled: z.boolean() }),
]);

const extractionRun = z.object({
  id: accountId, status: z.string().max(40), chunkTotal: z.number().int().nonnegative(),
  chunkCompleted: z.number().int().nonnegative(), createdAt: z.string(), completedAt: z.string().nullable(),
});
const exportHistoryEntry = z.object({
  id: accountId, status: z.string().max(40), refusalReason: z.string().nullable(), expiresAt: z.string(),
  consumedAt: z.string().nullable(), byteLength: z.number().int().nonnegative().nullable(), createdAt: z.string(),
});

export const desktopAccountSettingsOutput = {
  preferences: accountPreferences,
  savePreferences: z.object({ success: z.literal(true) }),
  loginMethods: z.object({ methods: z.array(loginMethod) }),
  email: emailSettings,
  saveEmail: emailSettings,
  memory: memoryPreferences.strip(),
  saveMemory: memoryPreferences.strip(),
  memories: z.object({
    total: z.number().int().min(0),
    memories: z.array(memorySummary),
  }),
  memoryDetail: z.object({
    // revision and projectId let the scope control move a memory; an older server omits them.
    memory: memorySummary.extend({ evidence: z.array(memoryEvidence),
      revision: z.number().int().positive().optional(), projectId: accountId.nullable().optional() }),
    conflicts: z.array(z.object({ id: accountId, statement: z.string() })),
  }),
  updateMemory: z.object({ ok: z.literal(true) }),
  addMemory: z.object({ memoryId: accountId }),
  assistants: z.object({ profiles: z.array(z.object({
    id: accountId, name: label, description: z.string().nullable(), published: z.boolean(),
  })) }),
  assistant: z.object({ profile: z.object({
    id: accountId, ...assistantIdentity.shape, versions: z.array(versionEntry),
    knowledgeFiles: z.array(z.object({ id: accountId, name: z.string(), processingStatus: z.string() })),
    currentVersion: versionEntry.extend({
      instructions: assistantInstructions, models: assistantModels, starters: assistantStarters, ...assistantPolicies,
      knowledgeManifest: z.array(z.object({ fileId: accountId, name: z.string() })),
    }).nullable(),
  }) }),
  saveAssistantIdentity: z.object({ profile: z.object({ id: accountId }) }),
  publishAssistant: z.object({ outcome: z.enum(["published", "unchanged"]) }),
  createAssistant: z.object({ profile: z.object({ id: accountId }) }),
  imports: z.object({
    total: z.number().int().min(0), offset: z.number().int().min(0), limit: z.number().int().positive(),
    continuationEnabled: z.boolean(),
    conversations: z.array(z.object({
      id: accountId, title: z.string(), provider: z.string(), titleWithheld: z.boolean(), messageCount: z.number(),
    })),
  }),
  importRuns: z.object({ imports: z.array(z.object({
    id: accountId, provider: z.string(), status: z.string(), conversationCount: importCount, createdAt: importTimestamp,
  })).max(50) }),
  importConversation: z.object({
    title: z.string(), messageTotal: importCount, limit: importCount.positive(), offset: importCount,
    messages: z.array(z.object({
      id: accountId, role: z.enum(["user", "assistant"]), content: z.string(),
      sourceModelLabel: z.string().nullable(), truncated: z.boolean(),
    })).max(100),
  }),
  importCapacity: z.object({
    remaining: z.object({ normalizedTextBytes: importCount, externalConversations: importCount, externalMessages: importCount }),
    usage: z.object({ normalizedTextBytes: importCount, externalConversations: importCount }).optional(),
    limits: z.object({ maxNormalizedTextBytes: importCount, maxExternalConversations: importCount }).optional(),
  }),
  startImport: z.object({ importId: accountId }),
  appendImport: z.object({ results: z.array(z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("staged"), stagedConversationId: accountId, conversationDigest: importDigest }),
    z.object({ outcome: z.literal("duplicate"), conversationDigest: importDigest }),
  ])) }),
  sealImport: z.object({ status: z.literal("preview_ready"), truncatedMessageCount: importCount }),
  importStatus: z.object({ status: z.string(), expired: z.boolean(), counts: z.object({ conversations: importCount }) }),
  finishImport: z.object({ finalizedConversations: importCount }),
  continueImport: z.object({ conversationId: accountId }),
  reviewContinuation: z.object({ conversationId: accountId }),
  pinConversation: z.discriminatedUnion("kind", [
    z.object({ kind: z.enum(["applied", "superseded"]), pinned: z.boolean(), seq: z.number().int().positive() }),
    z.object({ kind: z.enum(["gone", "refused", "failed"]) }),
  ]),
  projects: z.object({ projects: z.array(project) }),
  addProject: project,
  renameProject: project,
  removeProject: z.object({ success: z.literal(true) }),
  moveToProject: z.object({ projectId: accountId.nullable() }),
  changeConversationLock: z.object({ isLocked: z.boolean(), shareEnabled: z.boolean().optional() }),
  shareConversation: z.object({
    url: z.url().refine(value => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && /^\/share\/[A-Za-z0-9_-]+$/.test(url.pathname);
    }),
    expiresAt: importTimestamp,
  }),
  revokeConversationShare: z.object({ success: z.literal(true) }),
  keys: z.object({
    enabled: z.boolean(), keys: z.array(keySummary),
    limits: z.object({ maxKeys: z.number().int().positive(), maxCreditCap: z.number().int().positive(),
      expiryDays: z.array(z.number().int().positive()) }).optional(),
  }),
  createKey: z.object({ key: z.string().min(1).max(512), summary: keySummary }),
  updateKey: z.object({ key: keySummary }),
  revokeKey: z.object({ revoked: z.literal(true) }),
  deleteMemory: z.looseObject({ outcome: z.string() }),
  moveMemoryScope: z.object({ moved: z.boolean(), projectId: accountId.nullable() }),
  extractionRuns: z.object({ runs: z.array(extractionRun).max(50), activeRunId: accountId.nullable() }),
  cancelExtraction: z.looseObject({}),
  exportHistory: z.object({ requests: z.array(exportHistoryEntry).max(200) }),
  usage: z.object({
    plan: label,
    usage: z.object({ creditsMonth: z.number().nonnegative() }).optional(),
    limits: z.object({ creditsMonth: z.number().nonnegative() }).optional(),
    balances: z.object({
      dailyRemainingCredits: z.number().nullable(),
      planRemainingCredits: z.number().nullable(),
      purchasedRemainingCredits: z.number(),
    }),
  }),
};

export type DesktopAccountSettingsInput = z.infer<typeof desktopAccountSettingsInput>;
export type AccountSettingsAction = DesktopAccountSettingsInput["action"];
export type AccountSettingsResult<Action extends AccountSettingsAction> =
  z.infer<(typeof desktopAccountSettingsOutput)[Action]>;
export type AccountPreferences = z.infer<typeof accountPreferences>;
export type AccountTheme = z.infer<typeof accountTheme>;
