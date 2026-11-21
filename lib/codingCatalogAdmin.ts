// Operator writes the coding catalogue has and the image one does not: linking
// a chat registry model (one, or every candidate at once) and a link's own
// settings (owner decision 2026-11-20). Provider conditions are not collected
// any more (owner decision 2026-11-21). Every write commits with its audit row
// in one transaction, after the audit chain lock every catalogue writer takes
// first. Turning a model on stays in lib/modelCatalogAdmin.ts
// updateCatalogEntry, so one judge decides it.
import "server-only";

import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { z } from "zod";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { codingLookups, loadChatModelFacts, loadCodingProviderTerms, resolveCodingRow } from "@/lib/modelCatalog";
import { CatalogRefusal, updateCatalogEntry } from "@/lib/modelCatalogAdmin";
import {
  CODING_PLANS,
  CODING_STRUCTURED_OUTPUT,
  CODING_TOOL_CALLING,
  canonicalJson,
  codingCandidateExclusion,
  codingApiCreditWeightSchema,
  codingChannelsSchema,
  codingLinkedProfileSchema,
  codingStoredProfileSchema,
  defaultCodingCapabilitySources,
  isOfficialSourceUrl,
  registryCodingCapabilities,
  type CodingChannel,
  type CodingDedicatedProfile,
  type CodingLinkedProfile,
} from "@/lib/modelCatalogCore";
import type { CatalogDraftLlm, DraftPage } from "@/lib/modelCatalogDraftLlm";
import { prisma } from "@/lib/prisma";

/** Why this chat model cannot be linked now, or null. Read before the write and again inside it. */
const chatLinkRefusal = async (
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
 * Write one chat link inside the caller's transaction, after the audit chain
 * lock. No LLM call and no page read (owner decision 2026-11-21): the two
 * capability values come from the chat registry (registryCodingCapabilities),
 * and the link's evidence records that with no pages.
 */
const createChatLink = async (
  tx: Prisma.TransactionClient,
  input: { registryModelId: string; channels: CodingChannel[]; batch: boolean; session: Session; request?: Request }
) => {
  const refusal = await chatLinkRefusal(input.registryModelId, tx);
  if (refusal) throw new CatalogRefusal(refusal.code, refusal.reasons, 409);
  const capabilities = registryCodingCapabilities();
  const profile: CodingLinkedProfile = codingLinkedProfileSchema.parse({
    source: "chat",
    registryModelId: input.registryModelId,
    capabilities,
    channels: input.channels,
    evidence: { sources: [], draftedAt: new Date().toISOString().slice(0, 10), ...capabilities },
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
    summary: `Linked chat model ${input.registryModelId} into the coding catalogue${input.batch ? " (add all)" : " (switched off)"}.`,
    metadata: {
      modelId: input.registryModelId,
      toolCalling: profile.capabilities.toolCalling,
      structuredOutput: profile.capabilities.structuredOutput,
      channels: profile.channels,
      source: "chat_registry",
      batch: input.batch,
    },
    tx,
  });
  return row;
};

/**
 * Add a chat model to the coding catalogue as a link, switched off. Offered to
 * Code only until the operator ticks the other channels.
 */
export const linkChatModel = async (input: { registryModelId: string; session: Session; request?: Request }) =>
  prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    return createChatLink(tx, { ...input, channels: ["code"], batch: false });
  });

export type LinkAllResult = {
  /** Chat candidates the run looked at. */
  attempted: number;
  /** Models linked on the coding API and switched on. */
  added: string[];
  /** Of those, the ones that also pass Code's rules and were linked on Code too. */
  withCode: string[];
  /** Models left out, with the judge's reasons (a refused model leaves no row). */
  refused: { modelId: string; reasons: string[] }[];
  /** Refusal reasons counted across the run (a reason's detail after ":" is dropped). */
  reasonCounts: Record<string, number>;
  /** Why the added models without Code are not on Code, counted the same way. */
  codeReasonCounts: Record<string, number>;
  /** The added models without Code, with Code's reasons in full. */
  codeRefused: { modelId: string; reasons: string[] }[];
};

const reasonName = (reason: string) => reason.split(":")[0];

const count = (into: Record<string, number>, reasons: readonly string[]) => {
  for (const reason of new Set(reasons.map(reasonName))) into[reason] = (into[reason] ?? 0) + 1;
};

/**
 * Link every chat candidate on the coding API at chat's credits and switch it
 * on, and on Code too when it passes Code's rules (owner decision 2026-11-21).
 * A chat link is judged per channel (lib/modelCatalogCore.ts judgeCodingChannels):
 * the coding API runs it as its chat model under chat's limit and credits, so
 * Code's credit floor, context window and structured output do not stand in its
 * way. Credits are never raised here. One transaction per model: the link, its
 * audit row and the activation (the same judge as turning a model on by hand)
 * commit together or not at all, so a refused model leaves nothing behind and
 * one failure never stops the rest. No LLM call: the capability values come
 * from the chat registry, and the operator can fill them in later
 * (fillLinkCapabilities). The snapshot is not published here; the caller does
 * that in its own step.
 */
export const linkAllChatModels = async (input: { session: Session; request?: Request }): Promise<LinkAllResult> => {
  const [chat, existing, providerTerms] = await Promise.all([
    loadChatModelFacts(),
    prisma.modelCatalogEntry.findMany({ where: { category: "coding" }, select: { modelId: true } }),
    loadCodingProviderTerms(),
  ]);
  const lookups = codingLookups({ chat, providerTerms });
  const codingIds = new Set(existing.map((row) => row.modelId));
  const candidates = chat.filter((facts) => codingCandidateExclusion(facts, codingIds) === null);
  const result: LinkAllResult = { attempted: candidates.length, added: [], withCode: [], refused: [], reasonCounts: {}, codeReasonCounts: {}, codeRefused: [] };
  for (const facts of candidates) {
    // The link as it would be made, judged on both channels before anything is written.
    const probe = resolveCodingRow(
      {
        modelId: facts.id,
        enabled: null,
        holdReason: null,
        profile: { source: "chat", registryModelId: facts.id, capabilities: registryCodingCapabilities(), channels: ["code", "api"] },
        draft: null,
        draftCreatedAt: null,
      },
      lookups
    );
    const api = probe.channelAdmission.api;
    if (!api?.admitted) {
      const reasons = api && !api.admitted ? [...api.reasons] : [probe.problem ?? "no_valid_profile"];
      result.refused.push({ modelId: facts.id, reasons });
      count(result.reasonCounts, reasons);
      continue;
    }
    const code = probe.channelAdmission.code;
    const withCode = code?.admitted === true;
    try {
      await prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        await createChatLink(tx, {
          registryModelId: facts.id,
          channels: withCode ? ["code", "api"] : ["api"],
          batch: true,
          session: input.session,
          request: input.request,
        });
        await updateCatalogEntry({
          category: "coding",
          modelId: facts.id,
          patch: { enabled: true, holdReason: null },
          session: input.session,
          request: input.request,
          tx,
        });
      });
      result.added.push(facts.id);
      if (withCode) result.withCode.push(facts.id);
      else if (code && !code.admitted) {
        count(result.codeReasonCounts, code.reasons);
        result.codeRefused.push({ modelId: facts.id, reasons: [...code.reasons] });
      }
    } catch (error) {
      const reasons = error instanceof CatalogRefusal ? (error.reasons.length > 0 ? [...error.reasons] : [error.code]) : ["write_failed"];
      result.refused.push({ modelId: facts.id, reasons });
      count(result.reasonCounts, reasons);
    }
  }
  return result;
};

/** A link's own values. Null removes an override, so the chat value is read again. */
export const codingSettingsSchema = z
  .object({
    toolCalling: z.enum(CODING_TOOL_CALLING).optional(),
    structuredOutput: z.enum(CODING_STRUCTURED_OUTPUT).optional(),
    minimumPlan: z.enum(CODING_PLANS).nullable().optional(),
    creditWeight: z.number().int().positive().max(1_000).nullable().optional(),
    channels: codingChannelsSchema.optional(),
    /** A dedicated row's coding API credits; null puts it back on the chat rule's minimum. */
    apiCreditWeight: codingApiCreditWeightSchema.nullable().optional(),
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
 * A dedicated row's settings here (owner decision 2026-11-21): where it is
 * offered, and its coding API credits when they should be above the chat
 * rule's minimum (null removes the override). Everything else in its profile
 * is what its draft read, so it changes only through a new draft.
 */
export const applyDedicatedSettings = (
  stored: CodingDedicatedProfile,
  settings: CodingSettings
): { profile: CodingDedicatedProfile; changes: { field: string; from: unknown; to: unknown }[] } | null => {
  if (Object.keys(settings).some((field) => field !== "channels" && field !== "apiCreditWeight")) return null;
  const fromChannels = stored.channels ?? ["code"];
  const toChannels = settings.channels ?? fromChannels;
  const profile: CodingDedicatedProfile = { ...stored, channels: toChannels };
  if (settings.apiCreditWeight === null) delete profile.apiCreditWeight;
  else if (settings.apiCreditWeight !== undefined) profile.apiCreditWeight = settings.apiCreditWeight;
  const changes: { field: string; from: unknown; to: unknown }[] = [];
  if (canonicalJson(fromChannels) !== canonicalJson(toChannels)) changes.push({ field: "channels", from: fromChannels, to: toChannels });
  if ((stored.apiCreditWeight ?? null) !== (profile.apiCreditWeight ?? null)) {
    changes.push({ field: "apiCreditWeight", from: stored.apiCreditWeight ?? null, to: profile.apiCreditWeight ?? null });
  }
  return { profile, changes };
};

/**
 * Save a link's own settings, or a dedicated row's channels and coding API
 * credits. Goes through updateCatalogEntry, so a serving row is judged again
 * at the new values (a credit weight below the floor is refused there, not
 * saved). A coding API credit below the chat rule's minimum is saved: the
 * coding API refuses the row until it is raised, and Code is unaffected.
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
      parsed.data.source === "chat"
        ? input.settings.apiCreditWeight === undefined
          ? applyCodingSettings(parsed.data, input.settings)
          : null
        : applyDedicatedSettings(parsed.data, input.settings);
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

// --- capability information from the provider's documentation ------------------

/** What fillLinkCapabilities calls out to; tests inject these (the real ones are loaded on first use). */
export type CapabilityFillDeps = {
  draftLlm: () => Promise<CatalogDraftLlm | null>;
  fetchPage: (provider: string, url: string) => Promise<DraftPage>;
};

const defaultFillDeps: CapabilityFillDeps = {
  draftLlm: async () => (await import("@/lib/modelCatalogDraftLlm")).catalogDraftLlmFromEnv(),
  fetchPage: async (provider, url) => (await import("@/lib/modelCatalogDraftLlm")).fetchOfficialPage(provider, url),
};

/** Whether a link still carries the registry's conservative values rather than what the documentation says. */
export const capabilitiesNeedFilling = (profile: CodingLinkedProfile): boolean =>
  profile.capabilities.structuredOutput === "none" || (profile.evidence?.sources.length ?? 0) === 0;

/**
 * Fill one chat link's tool calling and structured output from the provider's
 * own documentation (owner decision 2026-11-21): the one paid call of linking,
 * made on request and for one row only (a caller with many rows sends one
 * request each, so no request outlives the HTTP limit). One LLM call over the
 * provider's default tool calling and structured output pages
 * (defaultCodingCapabilitySources); the answer is read by
 * codingCapabilitiesFromAnswer and every page must be on the provider's own
 * hosts. Any failure leaves the row as it was. A timeout is an unknown outcome
 * (the call may have been charged) and is reported, never retried here. The
 * channels are never touched: Code stays the operator's to tick. Goes through
 * updateCatalogEntry, so a serving row is judged at the new values; the audit
 * rows commit with the write.
 */
export const fillLinkCapabilities = async (input: {
  modelId: string;
  session: Session;
  request?: Request;
  deps?: Partial<CapabilityFillDeps>;
}) => {
  const deps = { ...defaultFillDeps, ...input.deps };
  const row = await prisma.modelCatalogEntry.findUnique({ where: { category_modelId: { category: "coding", modelId: input.modelId } } });
  if (!row) throw new CatalogRefusal("unknown_model", [], 404);
  const stored = codingStoredProfileSchema.safeParse(row.profile);
  if (!stored.success || stored.data.source !== "chat") throw new CatalogRefusal("settings_linked_only", [], 400);
  const registryModelId = stored.data.registryModelId;
  const facts = (await loadChatModelFacts()).find((model) => model.id === registryModelId);
  if (!facts) throw new CatalogRefusal("chat_model_missing", [], 409);
  const pages = defaultCodingCapabilitySources(facts.provider);
  if (!pages) throw new CatalogRefusal("no_capability_source", [facts.provider], 422);
  const llm = await deps.draftLlm();
  if (!llm) throw new CatalogRefusal("draft_llm_not_configured", [], 409);

  let draft: Awaited<ReturnType<CatalogDraftLlm["draftCodingCapabilities"]>>;
  try {
    const read: DraftPage[] = [];
    for (const url of [...new Set([pages.toolCalling, pages.structuredOutput])]) read.push(await deps.fetchPage(facts.provider, url));
    draft = await llm.draftCodingCapabilities({ provider: facts.provider, apiModelId: facts.apiModelId, pages: read });
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new CatalogRefusal("timeout_outcome_unknown", [], 504);
    const refusal = error as { name?: unknown; code?: unknown; detail?: unknown } | null;
    if (refusal?.name === "DraftRefusal" && typeof refusal.code === "string") {
      throw new CatalogRefusal(refusal.code, typeof refusal.detail === "string" ? [refusal.detail] : [], 422);
    }
    throw new CatalogRefusal("draft_failed", [], 502);
  }
  // The one cheap check on what the model answered: every page it stands on is the provider's own.
  const unofficial = draft.sources.find((url) => !isOfficialSourceUrl(facts.provider, url));
  if (unofficial || draft.sources.length === 0) throw new CatalogRefusal("unofficial_source", unofficial ? [unofficial] : [], 422);

  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const before = await tx.modelCatalogEntry.findUnique({ where: { category_modelId: { category: "coding", modelId: input.modelId } } });
    if (!before) throw new CatalogRefusal("unknown_model", [], 404);
    const current = codingStoredProfileSchema.safeParse(before.profile);
    if (!current.success || current.data.source !== "chat") throw new CatalogRefusal("settings_linked_only", [], 400);
    const next: CodingLinkedProfile = codingLinkedProfileSchema.parse({
      ...current.data,
      capabilities: { toolCalling: draft.toolCalling, structuredOutput: draft.structuredOutput },
      evidence: {
        sources: draft.sources.slice(0, 3),
        draftedAt: draft.draftedAt,
        toolCalling: draft.toolCalling,
        structuredOutput: draft.structuredOutput,
        ...(draft.note ? { note: draft.note } : {}),
      },
    });
    const changes: { field: string; from: unknown; to: unknown }[] = [];
    if (current.data.capabilities.toolCalling !== draft.toolCalling) {
      changes.push({ field: "toolCalling", from: current.data.capabilities.toolCalling, to: draft.toolCalling });
    }
    if (current.data.capabilities.structuredOutput !== draft.structuredOutput) {
      changes.push({ field: "structuredOutput", from: current.data.capabilities.structuredOutput, to: draft.structuredOutput });
    }
    const updated = await updateCatalogEntry({
      category: "coding",
      modelId: input.modelId,
      patch: { profile: next },
      session: input.session,
      request: input.request,
      tx,
      provenance: { codingSettings: changes },
    });
    await writeAdminAuditLog({
      session: input.session,
      request: input.request,
      action: "model_catalog.coding_capabilities_filled",
      targetType: "ModelCatalogEntry",
      targetId: `coding:${input.modelId}`,
      summary: `Filled the capabilities of coding link ${input.modelId} from ${facts.provider}'s documentation.`,
      metadata: {
        modelId: input.modelId,
        toolCalling: draft.toolCalling,
        structuredOutput: draft.structuredOutput,
        sources: next.evidence?.sources ?? [],
        changes: changes as unknown as Prisma.InputJsonValue,
      },
      tx,
    });
    return { row: updated, changes, draft };
  });
};
