// Operator writes the coding catalogue has and the image one does not: linking
// a chat registry model, a link's own settings, and the per-provider conditions
// (owner decision 2026-11-20). Every write commits with its audit row in one
// transaction, after the audit chain lock every catalogue writer takes first.
// Turning a model on stays in lib/modelCatalogAdmin.ts updateCatalogEntry, so
// one judge decides it.
import "server-only";

import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { z } from "zod";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { loadChatModelFacts } from "@/lib/modelCatalog";
import { CatalogRefusal, updateCatalogEntry } from "@/lib/modelCatalogAdmin";
import {
  CODING_PLANS,
  CODING_STRUCTURED_OUTPUT,
  CODING_TOOL_CALLING,
  canonicalJson,
  codingCandidateExclusion,
  codingChannelsSchema,
  codingLinkedProfileSchema,
  codingProviderTermsSchema,
  codingStoredProfileSchema,
  type CodingDedicatedProfile,
  type CodingLinkedProfile,
  type CodingProviderTerms,
} from "@/lib/modelCatalogCore";
import type { CodingCapabilitiesDraft } from "@/lib/modelCatalogDraftLlm";
import { prisma } from "@/lib/prisma";

const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Why this chat model cannot be linked now, or null. Read before the paid
 * draft call so a refusal costs nothing, and again inside the write.
 */
export const chatLinkRefusal = async (
  registryModelId: string,
  client: Pick<Prisma.TransactionClient, "modelCatalogEntry"> = prisma
): Promise<{ code: string; reasons: string[] } | null> => {
  const [chat, existing] = await Promise.all([
    loadChatModelFacts(),
    client.modelCatalogEntry.findUnique({
      where: { category_modelId: { category: "coding", modelId: registryModelId } },
      select: { modelId: true },
    }),
  ]);
  const facts = chat.find((model) => model.id === registryModelId);
  if (!facts) return { code: "chat_model_missing", reasons: [] };
  const exclusion = codingCandidateExclusion(facts, new Set(existing ? [existing.modelId] : []));
  return exclusion ? { code: exclusion === "already_in_catalog" ? "already_in_catalog" : "not_a_candidate", reasons: [exclusion] } : null;
};

/**
 * Add a chat model to the coding catalogue as a link, switched off, with the
 * LLM draft's tool calling and structured output. Offered to Code only until
 * the operator ticks the other channels.
 */
export const linkChatModel = async (input: {
  registryModelId: string;
  draft: CodingCapabilitiesDraft;
  session: Session;
  request?: Request;
}) =>
  prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const refusal = await chatLinkRefusal(input.registryModelId, tx);
    if (refusal) throw new CatalogRefusal(refusal.code, refusal.reasons, 409);
    const profile: CodingLinkedProfile = codingLinkedProfileSchema.parse({
      source: "chat",
      registryModelId: input.registryModelId,
      capabilities: { toolCalling: input.draft.toolCalling, structuredOutput: input.draft.structuredOutput },
      channels: ["code"],
      evidence: {
        sources: input.draft.sources.slice(0, 3),
        draftedAt: input.draft.draftedAt,
        toolCalling: input.draft.toolCalling,
        structuredOutput: input.draft.structuredOutput,
        ...(input.draft.note ? { note: input.draft.note } : {}),
      },
    });
    const row = await tx.modelCatalogEntry.create({
      data: {
        category: "coding",
        modelId: input.registryModelId,
        enabled: null,
        profile: profile as unknown as Prisma.InputJsonValue,
        draftSource: null,
        updatedById: input.session.user?.id ?? null,
        updatedByEmail: input.session.user?.email ?? null,
      },
    });
    await writeAdminAuditLog({
      session: input.session,
      request: input.request,
      action: "model_catalog.coding_linked",
      targetType: "ModelCatalogEntry",
      targetId: `coding:${input.registryModelId}`,
      summary: `Linked chat model ${input.registryModelId} into the coding catalogue (switched off).`,
      metadata: {
        modelId: input.registryModelId,
        toolCalling: profile.capabilities.toolCalling,
        structuredOutput: profile.capabilities.structuredOutput,
        sources: profile.evidence?.sources ?? [],
      },
      tx,
    });
    return row;
  });

/** A link's own values. Null removes an override, so the chat value is read again. */
export const codingSettingsSchema = z
  .object({
    toolCalling: z.enum(CODING_TOOL_CALLING).optional(),
    structuredOutput: z.enum(CODING_STRUCTURED_OUTPUT).optional(),
    minimumPlan: z.enum(CODING_PLANS).nullable().optional(),
    creditWeight: z.number().int().positive().max(1_000).nullable().optional(),
    channels: codingChannelsSchema.optional(),
  })
  .strict();
export type CodingSettings = z.infer<typeof codingSettingsSchema>;

/** The link with the operator's settings, and each field that changed (for the audit row). */
export const applyCodingSettings = (
  stored: CodingLinkedProfile,
  settings: CodingSettings
): { profile: CodingLinkedProfile; changes: { field: string; from: unknown; to: unknown }[] } => {
  const next: CodingLinkedProfile = {
    ...stored,
    capabilities: {
      toolCalling: settings.toolCalling ?? stored.capabilities.toolCalling,
      structuredOutput: settings.structuredOutput ?? stored.capabilities.structuredOutput,
    },
    channels: settings.channels ?? stored.channels,
  };
  if (settings.minimumPlan !== undefined) {
    if (settings.minimumPlan === null) delete next.minimumPlan;
    else next.minimumPlan = settings.minimumPlan;
  }
  if (settings.creditWeight !== undefined) {
    if (settings.creditWeight === null) delete next.creditWeight;
    else next.creditWeight = settings.creditWeight;
  }
  const changes: { field: string; from: unknown; to: unknown }[] = [];
  const compare = (field: string, from: unknown, to: unknown) => {
    if (canonicalJson(from ?? null) !== canonicalJson(to ?? null)) changes.push({ field, from: from ?? null, to: to ?? null });
  };
  compare("toolCalling", stored.capabilities.toolCalling, next.capabilities.toolCalling);
  compare("structuredOutput", stored.capabilities.structuredOutput, next.capabilities.structuredOutput);
  compare("minimumPlan", stored.minimumPlan, next.minimumPlan);
  compare("creditWeight", stored.creditWeight, next.creditWeight);
  compare("channels", stored.channels, next.channels);
  return { profile: next, changes };
};

/**
 * Where a dedicated row is offered: its channels are the one setting it has
 * here (owner decision 2026-11-21); everything else in its profile is what its
 * draft read, so it changes only through a new draft.
 */
export const applyDedicatedChannels = (
  stored: CodingDedicatedProfile,
  settings: CodingSettings
): { profile: CodingDedicatedProfile; changes: { field: string; from: unknown; to: unknown }[] } | null => {
  if (Object.keys(settings).some((field) => field !== "channels")) return null;
  const from = stored.channels ?? ["code"];
  const to = settings.channels ?? from;
  return {
    profile: { ...stored, channels: to },
    changes: canonicalJson(from) === canonicalJson(to) ? [] : [{ field: "channels", from, to }],
  };
};

/**
 * Save a link's own settings, or a dedicated row's channels. Goes through
 * updateCatalogEntry, so a serving row is judged again at the new values (a
 * credit weight below the floor is refused there, not saved).
 */
export const saveCodingSettings = async (input: {
  modelId: string;
  settings: CodingSettings;
  session: Session;
  request?: Request;
}) =>
  prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const before = await tx.modelCatalogEntry.findUnique({
      where: { category_modelId: { category: "coding", modelId: input.modelId } },
    });
    if (!before) throw new CatalogRefusal("unknown_model", [], 404);
    const parsed = codingStoredProfileSchema.safeParse(before.profile);
    if (!parsed.success) throw new CatalogRefusal("settings_linked_only", [], 400);
    const applied =
      parsed.data.source === "chat" ? applyCodingSettings(parsed.data, input.settings) : applyDedicatedChannels(parsed.data, input.settings);
    if (!applied) throw new CatalogRefusal("settings_linked_only", [], 400);
    const { profile, changes } = applied;
    if (changes.length === 0) return { row: before, changes };
    const row = await updateCatalogEntry({
      category: "coding",
      modelId: input.modelId,
      patch: { profile },
      session: input.session,
      request: input.request,
      tx,
      provenance: { codingSettings: changes },
    });
    return { row, changes };
  });

/**
 * Take a link that was never turned on (or is off) out of the catalogue. The
 * chat model is untouched and is a candidate again; the audit row keeps what
 * the link held.
 */
export const unlinkCodingModel = async (input: { modelId: string; session: Session; request?: Request }) =>
  prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const before = await tx.modelCatalogEntry.findUnique({
      where: { category_modelId: { category: "coding", modelId: input.modelId } },
    });
    if (!before) throw new CatalogRefusal("unknown_model", [], 404);
    if ((before.profile as { source?: unknown } | null)?.source !== "chat") throw new CatalogRefusal("unlink_linked_only", [], 400);
    if (before.enabled === true) throw new CatalogRefusal("unlink_turn_off_first", [], 409);
    await tx.modelCatalogEntry.delete({ where: { category_modelId: { category: "coding", modelId: input.modelId } } });
    await writeAdminAuditLog({
      session: input.session,
      request: input.request,
      action: "model_catalog.coding_unlinked",
      targetType: "ModelCatalogEntry",
      targetId: `coding:${input.modelId}`,
      summary: `Removed the coding link to chat model ${input.modelId}.`,
      metadata: { modelId: input.modelId, enabled: before.enabled, holdReason: before.holdReason, profile: before.profile as Prisma.JsonValue },
      tx,
    });
  });

// --- provider conditions ------------------------------------------------------

const assertProvider = (provider: string) => {
  if (!PROVIDER_PATTERN.test(provider)) throw new CatalogRefusal("invalid_provider", [], 400);
};

/** Store an LLM re-check of one provider's conditions. Nothing reads it until an operator applies it. */
export const storeProviderTermsDraft = async (input: {
  provider: string;
  draft: CodingProviderTerms;
  session: Session;
  request?: Request;
}) => {
  assertProvider(input.provider);
  const draft = codingProviderTermsSchema.parse(input.draft);
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const data = {
      draft: draft as unknown as Prisma.InputJsonValue,
      draftSource: "llm",
      draftCreatedAt: new Date(),
    };
    await tx.codingProviderTerms.upsert({
      where: { provider: input.provider },
      create: { provider: input.provider, ...data },
      update: data,
    });
    await writeAdminAuditLog({
      session: input.session,
      request: input.request,
      action: "model_catalog.provider_terms_draft_stored",
      targetType: "CodingProviderTerms",
      targetId: input.provider,
      summary: `Stored an LLM re-check of ${input.provider}'s coding conditions.`,
      metadata: { provider: input.provider, sources: draft.sources, allowsResaleAndCodingAgent: draft.allowsResaleAndCodingAgent },
      tx,
    });
    return draft;
  });
};

/**
 * Apply a provider's stored re-check after an operator compared it. Every
 * coding model of this provider is judged against it from the next read; the
 * draft and its application commit together, so a draft written in between is
 * neither applied nor lost.
 */
export const applyProviderTermsDraft = async (input: { provider: string; session: Session; request?: Request }) => {
  assertProvider(input.provider);
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const rows = await tx.$queryRaw<{ terms: unknown; draft: unknown }[]>`
      SELECT "terms", "draft" FROM "CodingProviderTerms"
      WHERE "provider" = ${input.provider}
      FOR UPDATE`;
    const row = rows[0];
    if (!row?.draft) throw new CatalogRefusal("no_draft", [], 404);
    const parsed = codingProviderTermsSchema.safeParse(row.draft);
    if (!parsed.success) throw new CatalogRefusal("invalid_draft", parsed.error.issues.map((i) => i.path.join(".")), 400);
    await tx.codingProviderTerms.update({
      where: { provider: input.provider },
      data: {
        terms: parsed.data as unknown as Prisma.InputJsonValue,
        draft: Prisma.DbNull,
        draftSource: null,
        draftCreatedAt: null,
        updatedById: input.session.user?.id ?? null,
        updatedByEmail: input.session.user?.email ?? null,
      },
    });
    await writeAdminAuditLog({
      session: input.session,
      request: input.request,
      action: "model_catalog.provider_terms_applied",
      targetType: "CodingProviderTerms",
      targetId: input.provider,
      summary: `Applied ${input.provider}'s coding conditions checked ${parsed.data.checkedAt}.`,
      metadata: {
        provider: input.provider,
        before: (row.terms ?? null) as Prisma.JsonValue,
        after: parsed.data as unknown as Prisma.JsonValue,
      },
      tx,
    });
    return parsed.data;
  });
};

export const discardProviderTermsDraft = async (input: { provider: string; session: Session; request?: Request }) => {
  assertProvider(input.provider);
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const before = await tx.codingProviderTerms.findUnique({ where: { provider: input.provider } });
    if (!before?.draft) throw new CatalogRefusal("no_draft", [], 404);
    await tx.codingProviderTerms.update({
      where: { provider: input.provider },
      data: { draft: Prisma.DbNull, draftSource: null, draftCreatedAt: null },
    });
    await writeAdminAuditLog({
      session: input.session,
      request: input.request,
      action: "model_catalog.provider_terms_draft_discarded",
      targetType: "CodingProviderTerms",
      targetId: input.provider,
      summary: `Discarded the LLM re-check of ${input.provider}'s coding conditions.`,
      metadata: { provider: input.provider },
      tx,
    });
  });
};
