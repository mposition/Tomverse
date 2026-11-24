import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hasConversationUnlockGrant } from "@/lib/conversationLock";
import { createConversation } from "@/lib/conversationCreation";
import { ResearchPreviewRunError } from "@/lib/deepResearchSettlementHandoff";
import { canUseModelWithPlan, type AiModel } from "@/lib/models";
import { createTokenEstimateAccumulator } from "@/lib/chatTokenEstimate";
import { RESEARCH_PREVIEW_P0_MODEL_SHORTLIST } from "@/lib/researchPreviewAdmission";
import {
  RESEARCH_ENGINE_VERSION, RESEARCH_MODEL_ROLES, RESEARCH_OUTPUT_TOKEN_CAPS, RESEARCH_PROFILES, RESEARCH_RESOURCE_LIMITS, RESEARCH_RUN_TERMINAL_STATUSES,
  researchBriefSchema, researchInputManifestSchema, researchPlanSchema, researchReportDocumentSchema, researchSectionKeySchema,
  researchSourceKeySchema, researchSourceSelectionSchema, type ResearchExecutionProfile, type ResearchInputManifest, type ResearchModelRole,
  type ResearchRunV2Dto,
} from "@/lib/researchEngineContract";
import { researchFundingAdapter } from "@/lib/researchEngineFunding";
import { researchNow } from "@/lib/researchEngineRuntime";
import { resolveResearchSelections, researchProjectSourcesAvailable } from "@/lib/researchEngineSources";
import { bumpRunSequence, enqueueResearchWorkItems, lockResearchRun, readResearchRunMoney } from "@/lib/researchEngineStore";
import { advanceResearchRun, createPublicRedaction, providerFor, researchRunDeadline, startResearchFromPlan } from "@/lib/researchEngineWorker";
import { researchPreviewLocale } from "@/lib/researchPreviewPrompt";

/**
 * User-facing operations of Research engine v2. Every mutation is owner-scoped,
 * takes the run row lock, checks an expected revision/sequence where a client
 * could act on stale state, and is idempotent so a lost response can be read
 * back without repeating the write. No offer or typing path calls a model.
 */

const refuse = (status: number, code: string, message: string) => new ResearchPreviewRunError(status, code, message);
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const digest = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

export function researchEngineFeatures(env: Record<string, string | undefined> = process.env) {
  const enabled = env.RESEARCH_ENGINE_ENABLED === "true";
  return {
    enabled,
    nativeEnabled: enabled && env.RESEARCH_ENGINE_NATIVE_ENABLED === "true",
    /** Rollout switch: offer the self-hosted engine as the default Research entry instead of Perplexity/Preview. */
    defaultEntry: enabled && env.RESEARCH_ENGINE_DEFAULT_ENTRY === "true",
    privateSources: enabled && env.RESEARCH_ENGINE_PRIVATE_SOURCES_ENABLED === "true",
    projectSources: enabled && researchProjectSourcesAvailable(),
    maxApprovedCredits: Math.max(1, Math.min(100_000, Number(env.RESEARCH_ENGINE_MAX_APPROVED_CREDITS) || 2_000)),
  };
}

/**
 * Engine v2 models beyond the Preview P0 pair. Each entry pins the provider API id. For each, AI SDK v7
 * reports reasoning inside outputTokens (the run output cap holds), and a forced-tool call with reasoning
 * "high", built as researchEngineModel builds it, returned exactly one tool call (checked 2026-11-24).
 * Anthropic models take forced tools only without thinking, so the SDK sends the one tool with "auto";
 * a reply without the tool call is the ordinary invalid-output path.
 */
export const RESEARCH_ENGINE_MODEL_SHORTLIST = [
  ...RESEARCH_PREVIEW_P0_MODEL_SHORTLIST,
  { id: "gemini-4-carbon", provider: "google", apiModel: "gemini-4-carbon" },
  { id: "gpt-6-2-sol", provider: "openai", apiModel: "gpt-6.2-sol" },
  { id: "claude-sonnet-5-5", provider: "anthropic", apiModel: "claude-sonnet-5-5" },
  { id: "claude-opus-5-5", provider: "anthropic", apiModel: "claude-opus-5-5" },
] as const;

export const researchEngineModelIsShortlisted = (model: Pick<AiModel, "id" | "provider" | "apiModel">) =>
  RESEARCH_ENGINE_MODEL_SHORTLIST.some((entry) => entry.id === model.id && entry.provider === model.provider && entry.apiModel === model.apiModel);

/** Roles map to shortlisted models only: an operator flag can choose among verified models, never add one. */
export function researchRoleModelIds(env: Record<string, string | undefined> = process.env): Record<ResearchModelRole, string> | null {
  const allowed = new Set((env.RESEARCH_ENGINE_MODEL_IDS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
  const shortlist: string[] = RESEARCH_ENGINE_MODEL_SHORTLIST.map((entry): string => entry.id).filter((id) => allowed.has(id));
  if (!shortlist.length) return null;
  const overrides = Object.fromEntries((env.RESEARCH_ENGINE_ROLE_MODELS ?? "").split(",").map((entry) => entry.split("=").map((part) => part.trim()))
    .filter((pair) => pair.length === 2 && (RESEARCH_MODEL_ROLES as readonly string[]).includes(pair[0]!) && shortlist.includes(pair[1]!)));
  return Object.fromEntries(RESEARCH_MODEL_ROLES.map((role) => [role, overrides[role] ?? shortlist[0]!])) as Record<ResearchModelRole, string>;
}

async function runtimeModels() {
  const { getRuntimeModels } = await import("@/lib/modelRegistry");
  return getRuntimeModels({ includeCatalogDeleted: true });
}

async function pinExecutionProfile(userId: string, profile: "standard" | "deep"): Promise<{ profile: ResearchExecutionProfile; writer: AiModel; perCall: number }> {
  const roles = researchRoleModelIds();
  if (!roles) throw refuse(409, "RESEARCH_ENGINE_UNAVAILABLE", "Deep Research is unavailable.");
  const models = await runtimeModels();
  const funding = await researchFundingAdapter();
  const pinned = {} as ResearchExecutionProfile["roles"];
  let perCall = 0;
  for (const role of RESEARCH_MODEL_ROLES) {
    const model = models.find((candidate) => candidate.id === roles[role]);
    if (!model || !model.enabled || model.catalogDeleted || !researchEngineModelIsShortlisted(model)) {
      throw refuse(409, "RESEARCH_ENGINE_UNAVAILABLE", "Deep Research is unavailable.");
    }
    const estimate = await funding.estimate({ userId, model, outputTokenCap: RESEARCH_OUTPUT_TOKEN_CAPS.investigate, searchEnabled: role === "researcher",
      inputEstimate: createTokenEstimateAccumulator().addText("x".repeat(24_000)).breakdown() }).catch((error: unknown) => {
      // Research without a fundable web search cannot run; say so before anything starts.
      if ((error as { code?: string })?.code === "RESEARCH_SEARCH_UNAVAILABLE") {
        throw refuse(409, "RESEARCH_SEARCH_UNAVAILABLE", "Web search is not available for Deep Research right now.");
      }
      throw error;
    });
    perCall = Math.max(perCall, estimate.credits);
    pinned[role] = { modelId: model.id, provider: model.provider, apiModel: model.apiModel,
      reasoning: model.reasoning ?? "provider-default", pricingVersion: estimate.pricingVersion };
  }
  const writer = models.find((candidate) => candidate.id === roles.writer)!;
  return { profile: { version: 1, profile, roles: pinned, pinnedAt: researchNow().toISOString() }, writer, perCall };
}

/** Typical call counts per profile, for an honest range. Not a promise and not a cap. */
export function researchEstimateRange(perCallCredits: number, profileName: "standard" | "deep") {
  const profile = RESEARCH_PROFILES[profileName];
  const low = 1 + Math.ceil(profile.maxSubquestions / 2) * 2 + 1 + 1 + Math.ceil(profile.maxSections / 2) + 1;
  const high = 1 + profile.maxSubquestions * profile.maxInvestigateTurnsPerQuestion + profile.maxCoordinatorRounds + 4 +
    profile.maxSections * (1 + profile.maxRepairAttempts) + 1;
  return { lowCredits: low * perCallCredits, highCredits: high * perCallCredits, perCallCredits };
}

async function assertEligible(userId: string) {
  const features = researchEngineFeatures();
  if (!features.enabled) throw refuse(404, "RESEARCH_ENGINE_DISABLED", "Deep Research is unavailable.");
  const { getUserBillingPlan } = await import("@/lib/billingEntitlements");
  const { getOperationalFeatureFlags } = await import("@/lib/appSettings");
  const [plan, flags] = await Promise.all([getUserBillingPlan(userId), getOperationalFeatureFlags()]);
  if (!flags.aiChatEnabled) throw refuse(503, "RESEARCH_ENGINE_PAUSED", "Deep Research is temporarily paused.");
  if (!plan.tier || !canUseModelWithPlan(plan.tier, { minimumPlan: "Pro" })) throw refuse(403, "RESEARCH_PLAN_REQUIRED", "Deep Research requires Pro or higher.");
  return { features, plan };
}

/** Availability and an estimate range. Deterministic; never calls a model or search. */
export async function researchEngineOffer(userId: string, profile: "standard" | "deep" = "standard") {
  try {
    const { features } = await assertEligible(userId);
    const pinned = await pinExecutionProfile(userId, profile);
    return { offered: true as const, reason: "ready" as const, features,
      estimate: researchEstimateRange(pinned.perCall, profile), profiles: Object.keys(RESEARCH_PROFILES),
      limits: { maxBriefCharacters: RESEARCH_RESOURCE_LIMITS.maxBriefCharacters, maxSources: RESEARCH_RESOURCE_LIMITS.maxManifestEntries,
        maxApprovedCredits: features.maxApprovedCredits },
      filterSupport: { searchLanguage: "backend", country: "backend", freshness: "backend", domains: "post_filter", period: "model_guidance" } };
  } catch (error) {
    return { offered: false as const, reason: error instanceof ResearchPreviewRunError ? error.code : "RESEARCH_ENGINE_UNAVAILABLE" };
  }
}

export const researchRunCreateSchema = z.object({
  conversationId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  userMessageId: z.string().uuid(),
  assistantMessageId: z.string().uuid(),
  brief: researchBriefSchema,
  /**
   * The only free text search-capable roles see. When the user gives it, nothing
   * else they typed (objective, constraints) is sent toward web search; when
   * absent it defaults to the question with the objective and constraints.
   */
  publicBrief: z.string().trim().min(1).max(RESEARCH_RESOURCE_LIMITS.maxBriefCharacters).optional(),
  sources: z.array(researchSourceSelectionSchema).max(RESEARCH_RESOURCE_LIMITS.maxManifestEntries).default([]),
  profile: z.enum(["standard", "deep"]).default("standard"),
  approvedCredits: z.number().int().min(1).max(100_000),
  autoStart: z.boolean().default(false),
  /**
   * Creating a run asks for its plan, the one step both start modes share ("make a
   * plan" and "start" both begin there). Only an explicit false keeps a draft with
   * no paid call, for a client that adds sources before planning.
   */
  requestPlan: z.boolean().optional(),
  locale: z.string().trim().min(2).max(35).optional(),
}).strict();
export type ResearchRunCreateInput = z.infer<typeof researchRunCreateSchema>;

/** Without an explicit public text the whole typed brief is public, as the question itself is. */
function defaultPublicBrief(brief: ResearchRunCreateInput["brief"]) {
  const extra = [brief.objective ? `Objective: ${brief.objective}` : "", ...brief.constraints.map((constraint) => `Constraint: ${constraint}`)]
    .filter(Boolean).join("\n");
  const room = RESEARCH_RESOURCE_LIMITS.maxBriefCharacters - brief.question.length - 2;
  return extra && room > 0 ? `${brief.question}\n\n${extra.slice(0, room)}`.trim() : brief.question;
}

export async function createResearchRun(input: { request: Request; userId: string; payload: ResearchRunCreateInput }) {
  const { features } = await assertEligible(input.userId);
  const { payload } = input;
  if (payload.approvedCredits > features.maxApprovedCredits) throw refuse(400, "RESEARCH_BUDGET_TOO_HIGH", "That maximum is above the allowed research total.");
  const existing = await prisma.researchPreviewRun.findFirst({ where: { assistantMessageId: payload.assistantMessageId } });
  if (existing) {
    if (existing.userId !== input.userId || existing.engineVersion !== 2 || existing.sourceUserMessageId !== payload.userMessageId) {
      throw refuse(409, "RESEARCH_RUN_ID_REUSED", "The response identity is already in use.");
    }
    return { created: false as const, run: await readResearchRunDto(input.userId, existing.id, input.request) };
  }
  const privateSelections = payload.sources.filter((source) => source.type !== "url");
  if (privateSelections.length && !features.privateSources) throw refuse(409, "RESEARCH_PRIVATE_SOURCES_DISABLED", "Private sources are not available yet.");
  const entries = await resolveResearchSelections({ userId: input.userId, request: input.request, selections: payload.sources });
  const pinned = await pinExecutionProfile(input.userId, payload.profile);
  const locale = researchPreviewLocale(payload.locale ?? input.request.headers.get("accept-language"));
  const now = researchNow();
  const manifest: ResearchInputManifest = researchInputManifestSchema.parse({
    version: 1, brief: payload.brief, publicBrief: payload.publicBrief ?? defaultPublicBrief(payload.brief), entries, profile: payload.profile,
    locale, currentDate: now.toISOString().slice(0, 10), amendments: [], autoStart: payload.autoStart, revisionRequests: [],
  });
  const finalizationReserve = Math.min(payload.approvedCredits, Math.max(pinned.perCall * 3, Math.ceil(payload.approvedCredits * 0.2)));
  const run = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`research-engine-assistant:${payload.assistantMessageId}`}))`;
    let conversationId = payload.conversationId;
    if (conversationId) {
      const conversation = await tx.conversation.findFirst({ where: { id: conversationId, userId: input.userId },
        select: { id: true, kind: true, productKey: true, password: true, passwordVersion: true } });
      if (!conversation || conversation.kind !== "chat" || conversation.productKey !== "chat") throw refuse(409, "RESEARCH_CONVERSATION_UNAVAILABLE", "This conversation cannot hold research.");
      if (conversation.password != null && !hasConversationUnlockGrant(input.request, input.userId, conversation.id, conversation.passwordVersion)) {
        throw refuse(423, "RESEARCH_CONVERSATION_LOCKED", "Unlock this conversation first.");
      }
    } else {
      const created = await createConversation(tx, { userId: input.userId, title: payload.brief.question.slice(0, 80), productKey: "chat",
        selectedModels: JSON.stringify([pinned.writer.id]) }, { id: true });
      conversationId = created.id;
    }
    if (await tx.message.findUnique({ where: { id: payload.userMessageId }, select: { id: true } })) throw refuse(409, "RESEARCH_RUN_ID_REUSED", "The message identity is already in use.");
    await tx.message.create({ data: { id: payload.userMessageId, role: "user", content: payload.brief.question, status: "normal", conversationId } });
    const created = await tx.researchPreviewRun.create({ data: {
      userId: input.userId, conversationId, sourceUserMessageId: payload.userMessageId, assistantMessageId: payload.assistantMessageId,
      modelId: pinned.writer.id, provider: pinned.writer.provider, apiModel: pinned.writer.apiModel, locale, currentDate: manifest.currentDate,
      questionDigest: digest(payload.brief.question), pageReadingEnabled: true, totalOutputTokens: 1, inputTokenCeiling: 1, searchSurchargeCredits: 0,
      status: "draft", engineVersion: RESEARCH_ENGINE_VERSION, inputManifest: json(manifest), executionProfile: json(pinned.profile),
      approvedCredits: payload.approvedCredits, finalizationReserveCredits: finalizationReserve,
    } });
    for (const entry of entries) {
      if (entry.type === "url") {
        await tx.researchSource.create({ data: { runId: created.id, sourceKey: entry.key, origin: "user_url", visibility: "public",
          canonicalUrl: entry.url, firstSeenAt: now } });
      } else {
        await tx.researchSource.create({ data: { runId: created.id, sourceKey: entry.key, origin: entry.type, visibility: "private",
          title: entry.label, ownerRef: json({ type: entry.type, revision: entry.revision }), firstSeenAt: now } });
      }
    }
    return created;
  });
  if (payload.autoStart || payload.requestPlan !== false) await requestResearchPlan({ request: input.request, userId: input.userId, runId: run.id, expectedPlanRevision: 0 });
  return { created: true as const, run: await readResearchRunDto(input.userId, run.id, input.request) };
}

async function ownedRunForMutation(tx: Prisma.TransactionClient, userId: string, runId: string, request?: Request) {
  await lockResearchRun(tx, runId);
  const run = await tx.researchPreviewRun.findFirst({ where: { id: runId, userId, engineVersion: 2 },
    include: { conversation: { select: { password: true, passwordVersion: true } } } });
  if (!run) throw refuse(404, "RESEARCH_RUN_NOT_FOUND", "Research run not found.");
  if (run.conversation.password != null && !(request && hasConversationUnlockGrant(request, userId, run.conversationId, run.conversation.passwordVersion))) {
    throw refuse(423, "RESEARCH_CONVERSATION_LOCKED", "Unlock this conversation before changing Research.");
  }
  return run;
}

/** Explicit, paid action: queues one planning call funded from the approved total. */
export async function requestResearchPlan(input: { request: Request; userId: string; runId: string; expectedPlanRevision: number; feedback?: string }) {
  await prisma.$transaction(async (tx) => {
    const run = await ownedRunForMutation(tx, input.userId, input.runId, input.request);
    if (run.planRevision !== input.expectedPlanRevision) {
      // Idempotent readback: a plan request already made for this revision is not repeated.
      if (run.status === "planning" || run.planRevision > input.expectedPlanRevision) return;
      throw refuse(409, "RESEARCH_PLAN_STALE", "The plan changed; reload it first.");
    }
    if (!["draft", "awaiting_input"].includes(run.status) || run.approvedPlanRevision) throw refuse(409, "RESEARCH_PLAN_NOT_ALLOWED", "A plan can no longer be requested.");
    await enqueueResearchWorkItems(tx, run.id, [{ kind: "plan", idempotencyKey: `plan:${run.planRevision + 1}`, planRevision: run.planRevision,
      inputRevision: run.inputRevision, providerKey: providerFor(run, "planner"), payload: { kind: "plan", ...(input.feedback ? { feedback: input.feedback.slice(0, 4_000) } : {}) } }]);
    await bumpRunSequence(tx, run.id, { status: "planning", lastErrorCode: null });
  });
  return readResearchRunDto(input.userId, input.runId, input.request);
}

export async function editResearchPlan(input: { request: Request; userId: string; runId: string; expectedPlanRevision: number; plan: unknown }) {
  const parsed = researchPlanSchema.parse(input.plan);
  await prisma.$transaction(async (tx) => {
    const run = await ownedRunForMutation(tx, input.userId, input.runId, input.request);
    if (run.status !== "awaiting_input" || run.approvedPlanRevision) throw refuse(409, "RESEARCH_PLAN_NOT_EDITABLE", "This plan can no longer be edited.");
    if (run.planRevision !== input.expectedPlanRevision) throw refuse(409, "RESEARCH_PLAN_STALE", "The plan changed; reload it first.");
    const profile = RESEARCH_PROFILES[researchInputManifestSchema.parse(run.inputManifest).profile];
    if (parsed.subquestions.length > profile.maxSubquestions || parsed.outline.length > profile.maxSections) throw refuse(400, "RESEARCH_PLAN_TOO_LARGE", "The plan is larger than this profile allows.");
    const revision = run.planRevision + 1;
    await tx.researchPlanRevision.create({ data: { runId: run.id, revision, author: "user", inputRevision: run.inputRevision, plan: json(parsed) } });
    await bumpRunSequence(tx, run.id, { planRevision: revision });
  });
  return readResearchRunDto(input.userId, input.runId, input.request);
}

export async function approveResearchPlan(input: { request: Request; userId: string; runId: string; planRevision: number }) {
  await prisma.$transaction(async (tx) => {
    const run = await ownedRunForMutation(tx, input.userId, input.runId, input.request);
    if (run.approvedPlanRevision === input.planRevision) return; // idempotent readback
    if (run.status !== "awaiting_input" || run.approvedPlanRevision) throw refuse(409, "RESEARCH_PLAN_NOT_APPROVABLE", "This plan cannot be started.");
    if (run.planRevision !== input.planRevision) throw refuse(409, "RESEARCH_PLAN_STALE", "The plan changed; reload it first.");
    const row = await tx.researchPlanRevision.findUniqueOrThrow({ where: { runId_revision: { runId: run.id, revision: input.planRevision } } });
    await startResearchFromPlan(tx, run, researchInputManifestSchema.parse(run.inputManifest), researchPlanSchema.parse(row.plan), input.planRevision);
  });
  return readResearchRunDto(input.userId, input.runId, input.request);
}

export async function pauseResearchRun(input: { request: Request; userId: string; runId: string }) {
  await prisma.$transaction(async (tx) => {
    const run = await ownedRunForMutation(tx, input.userId, input.runId, input.request);
    if (run.pauseRequestedAt || RESEARCH_RUN_TERMINAL_STATUSES.has(run.status)) return;
    if (!["queued", "running", "finalizing", "planning"].includes(run.status)) throw refuse(409, "RESEARCH_PAUSE_NOT_ALLOWED", "This research cannot be paused now.");
    await bumpRunSequence(tx, run.id, { pauseRequestedAt: researchNow() });
  });
  await advanceResearchRun(input.runId);
  return readResearchRunDto(input.userId, input.runId, input.request);
}

export async function resumeResearchRun(input: { request: Request; userId: string; runId: string }) {
  await prisma.$transaction(async (tx) => {
    const run = await ownedRunForMutation(tx, input.userId, input.runId, input.request);
    if (!run.pauseRequestedAt && run.status !== "paused") return;
    if (run.cancelRequestedAt) throw refuse(409, "RESEARCH_RUN_CANCELLED", "This research was cancelled.");
    const finalOpen = await tx.researchWorkItem.count({ where: { runId: run.id, kind: { in: ["verify", "write_section", "synthesize"] }, status: { in: ["queued", "running", "blocked"] } } });
    const planOpen = await tx.researchWorkItem.count({ where: { runId: run.id, kind: "plan", status: { in: ["queued", "running"] } } });
    // Time spent paused does not count against the run deadline.
    const now = researchNow();
    const pausedFor = run.pausedAt ? Math.max(0, now.getTime() - run.pausedAt.getTime()) : 0;
    await bumpRunSequence(tx, run.id, { pauseRequestedAt: null, pausedAt: null,
      ...(run.runDeadlineAt && pausedFor ? { runDeadlineAt: new Date(run.runDeadlineAt.getTime() + pausedFor) } : {}),
      status: run.status !== "paused" ? run.status : planOpen ? "planning" : finalOpen ? "finalizing" : "queued" });
  });
  await advanceResearchRun(input.runId);
  return readResearchRunDto(input.userId, input.runId, input.request);
}

export async function cancelResearchRun(input: { request: Request; userId: string; runId: string }) {
  await prisma.$transaction(async (tx) => {
    const run = await ownedRunForMutation(tx, input.userId, input.runId, input.request);
    if (run.cancelRequestedAt || RESEARCH_RUN_TERMINAL_STATUSES.has(run.status)) return;
    await bumpRunSequence(tx, run.id, { cancelRequestedAt: researchNow(), ...(["draft", "awaiting_input", "paused"].includes(run.status) ? {} : {}) });
  });
  await advanceResearchRun(input.runId);
  const run = await prisma.researchPreviewRun.findUnique({ where: { id: input.runId }, select: { status: true } });
  if (run && ["draft", "awaiting_input", "paused"].includes(run.status)) {
    await prisma.$transaction(async (tx) => {
      await lockResearchRun(tx, input.runId);
      const running = await tx.researchWorkItem.count({ where: { runId: input.runId, status: "running" } });
      if (!running) await bumpRunSequence(tx, input.runId, { status: "cancelled", stopReason: "cancelled", completedAt: researchNow() });
    });
  }
  return readResearchRunDto(input.userId, input.runId, input.request);
}

/** Only an explicit user action raises the approved total. No purchase is made here. */
export async function extendResearchBudget(input: { request: Request; userId: string; runId: string; expectedApprovedCredits: number; approvedCredits: number }) {
  const { features } = await assertEligible(input.userId);
  await prisma.$transaction(async (tx) => {
    const run = await ownedRunForMutation(tx, input.userId, input.runId, input.request);
    if (run.approvedCredits === input.approvedCredits) return; // idempotent readback
    if (run.approvedCredits !== input.expectedApprovedCredits) throw refuse(409, "RESEARCH_BUDGET_STALE", "The research total changed; reload it first.");
    if (input.approvedCredits <= (run.approvedCredits ?? 0) || input.approvedCredits > features.maxApprovedCredits) {
      throw refuse(400, "RESEARCH_BUDGET_INVALID", "The new maximum must be higher and within the allowed total.");
    }
    if (RESEARCH_RUN_TERMINAL_STATUSES.has(run.status) || run.cancelRequestedAt) throw refuse(409, "RESEARCH_RUN_FINISHED", "This research has finished.");
    await tx.researchWorkItem.updateMany({ where: { runId: run.id, status: "blocked" }, data: { status: "queued", errorCode: null } });
    await bumpRunSequence(tx, run.id, { approvedCredits: input.approvedCredits,
      ...(run.status === "awaiting_input" && run.lastErrorCode === "RESEARCH_RUN_BUDGET_REACHED"
        ? { status: run.approvedPlanRevision ? "queued" : "planning", lastErrorCode: null } : {}) });
  });
  await advanceResearchRun(input.runId);
  return readResearchRunDto(input.userId, input.runId, input.request);
}

/** Stops further research and writes the report from the evidence already gathered. */
export async function finishResearchNow(input: { request: Request; userId: string; runId: string }) {
  await prisma.$transaction(async (tx) => {
    const run = await ownedRunForMutation(tx, input.userId, input.runId, input.request);
    if (run.lastErrorCode === "RESEARCH_FINALIZE_REQUESTED" || run.status === "finalizing") return; // readback
    const waiting = run.status === "awaiting_input" && run.lastErrorCode === "RESEARCH_RUN_BUDGET_REACHED";
    if (!run.approvedPlanRevision || !(waiting || ["queued", "running"].includes(run.status)) || run.cancelRequestedAt) {
      throw refuse(409, "RESEARCH_FINISH_NOT_ALLOWED", "This research cannot be finished now.");
    }
    await tx.researchWorkItem.updateMany({ where: { runId: run.id, status: { in: ["queued", "blocked"] },
      kind: { in: ["investigate", "search", "read", "analyze_private", "coordinate"] } }, data: { status: "superseded", errorCode: "RESEARCH_FINALIZE_REQUESTED" } });
    await bumpRunSequence(tx, run.id, { status: "running", lastErrorCode: "RESEARCH_FINALIZE_REQUESTED" });
  });
  await advanceResearchRun(input.runId);
  return readResearchRunDto(input.userId, input.runId, input.request);
}

export const researchScopeAmendmentSchema = z.object({
  expectedInputRevision: z.number().int().min(0),
  /** Public research text: each question is researched on the web like the public brief. */
  addQuestions: z.array(z.string().trim().min(1).max(2_000)).max(10).default([]),
  /** Private note: kept in the manifest, never sent to a search-capable role. */
  excludeSourceKeys: z.array(researchSourceKeySchema).max(100).default([]),
  excludeDomains: z.array(z.string().trim().toLowerCase().max(253)).max(30).default([]),
  priorityNote: z.string().trim().min(1).max(1_000).optional(),
}).strict();

/** Mid-run scope change. Applies to work created after it; already-dispatched work is not repeated. */
export async function amendResearchScope(input: { request: Request; userId: string; runId: string; amendment: z.infer<typeof researchScopeAmendmentSchema> }) {
  await prisma.$transaction(async (tx) => {
    const run = await ownedRunForMutation(tx, input.userId, input.runId, input.request);
    if (run.inputRevision !== input.amendment.expectedInputRevision) {
      if (run.inputRevision > input.amendment.expectedInputRevision) return;
      throw refuse(409, "RESEARCH_SCOPE_STALE", "The scope changed; reload it first.");
    }
    if (RESEARCH_RUN_TERMINAL_STATUSES.has(run.status) || run.cancelRequestedAt) throw refuse(409, "RESEARCH_RUN_FINISHED", "This research has finished.");
    const manifest = researchInputManifestSchema.parse(run.inputManifest);
    const inputRevision = run.inputRevision + 1;
    const next = researchInputManifestSchema.parse({ ...manifest, amendments: [...manifest.amendments, {
      inputRevision, addQuestions: input.amendment.addQuestions, excludeSourceKeys: input.amendment.excludeSourceKeys,
      excludeDomains: input.amendment.excludeDomains, ...(input.amendment.priorityNote ? { priorityNote: input.amendment.priorityNote } : {}) }] });
    if (input.amendment.excludeSourceKeys.length) {
      await tx.researchSource.updateMany({ where: { runId: run.id, sourceKey: { in: input.amendment.excludeSourceKeys }, status: "active" }, data: { status: "excluded" } });
      await tx.researchWorkItem.updateMany({ where: { runId: run.id, status: "queued", kind: { in: ["read", "analyze_private"] },
        OR: input.amendment.excludeSourceKeys.map((key) => ({ payload: { path: ["sourceKey"], equals: key } })) }, data: { status: "superseded", errorCode: "RESEARCH_SOURCE_EXCLUDED" } });
    }
    if (run.approvedPlanRevision && ["queued", "running", "paused"].includes(run.status)) {
      await enqueueResearchWorkItems(tx, run.id, input.amendment.addQuestions.map((question, index) => ({ kind: "investigate" as const,
        idempotencyKey: `inv:0:amend${inputRevision}_${index}:t1`, planRevision: run.approvedPlanRevision!, inputRevision,
        providerKey: providerFor(run, "researcher"), priority: 2,
        payload: { kind: "investigate" as const, questionKey: `amend${inputRevision}_${index}`, question, queries: [question.slice(0, 400)], turn: 1 } })));
    }
    await bumpRunSequence(tx, run.id, { inputManifest: json(next), inputRevision });
  });
  await advanceResearchRun(input.runId);
  return readResearchRunDto(input.userId, input.runId, input.request);
}

export const researchRevisionRequestInputSchema = z.object({
  expectedReportRevision: z.number().int().min(1),
  kind: z.enum(["format", "section_research", "conditions", "refresh", "redact_public"]),
  sectionKeys: z.array(researchSectionKeySchema).max(20).default([]),
  /**
   * For section_research and conditions this is public research text (it directs
   * the new web research); for format, refresh and redact_public it reaches only
   * the writer, which has no search tool.
   */
  instruction: z.string().trim().max(4_000).optional(),
}).strict();

/**
 * One new report revision. Format changes reuse the verified claims without new
 * research; section research and condition changes research only what changed;
 * refresh re-reads cited public sources as new versions; redact_public is model-free.
 */
export async function requestResearchRevision(input: { request: Request; userId: string; runId: string; revision: z.infer<typeof researchRevisionRequestInputSchema> }) {
  const request = input.revision;
  if (request.kind === "redact_public") {
    const run = await prisma.$transaction((tx) => ownedRunForMutation(tx, input.userId, input.runId, input.request));
    if (run.currentReportRevision !== request.expectedReportRevision) throw refuse(409, "RESEARCH_REPORT_STALE", "The report changed; reload it first.");
    const existing = await prisma.researchReportRevision.findFirst({ where: { runId: run.id, parentRevision: request.expectedReportRevision, author: "redaction" } });
    if (!existing) await createPublicRedaction(run.id, request.expectedReportRevision);
    return readResearchRunDto(input.userId, input.runId, input.request);
  }
  await prisma.$transaction(async (tx) => {
    const run = await ownedRunForMutation(tx, input.userId, input.runId, input.request);
    const manifest = researchInputManifestSchema.parse(run.inputManifest);
    if (manifest.revisionRequests.some((entry) => entry.parentRevision === request.expectedReportRevision && entry.kind === request.kind &&
      JSON.stringify(entry.sectionKeys) === JSON.stringify(request.sectionKeys) && entry.instruction === request.instruction)) return; // readback
    if (run.status !== "completed" || run.currentReportRevision !== request.expectedReportRevision) {
      throw refuse(409, "RESEARCH_REPORT_STALE", "The report changed or is still being written.");
    }
    const inputRevision = run.inputRevision + 1;
    const next = researchInputManifestSchema.parse({ ...manifest, revisionRequests: [...manifest.revisionRequests, {
      inputRevision, parentRevision: request.expectedReportRevision, kind: request.kind, sectionKeys: request.sectionKeys,
      ...(request.instruction ? { instruction: request.instruction } : {}) }],
      ...(request.kind === "conditions" && request.instruction ? { amendments: [...manifest.amendments, { inputRevision, addQuestions: [],
        excludeSourceKeys: [], excludeDomains: [], priorityNote: request.instruction }] } : {}) });
    const plan = run.approvedPlanRevision ? researchPlanSchema.parse((await tx.researchPlanRevision.findUniqueOrThrow({
      where: { runId_revision: { runId: run.id, revision: run.approvedPlanRevision } } })).plan) : null;
    const items: Parameters<typeof enqueueResearchWorkItems>[2][number][] = [];
    if ((request.kind === "section_research" || request.kind === "conditions") && plan) {
      const sections = request.kind === "conditions" ? plan.outline : plan.outline.filter((section) => request.sectionKeys.includes(section.key));
      const keys = new Set(sections.flatMap((section) => section.subquestionKeys));
      for (const question of plan.subquestions.filter((entry) => keys.has(entry.key) || request.kind === "conditions")) {
        items.push({ kind: "investigate", idempotencyKey: `inv:${inputRevision}:${question.key}:t1`, planRevision: run.approvedPlanRevision!, inputRevision,
          providerKey: providerFor(run, "researcher"), priority: 1, payload: { kind: "investigate", questionKey: question.key,
            question: request.instruction ? `${question.question}\n(${request.instruction})` : question.question, queries: question.queries, turn: 1,
            requestRevision: inputRevision } });
      }
    }
    if (request.kind === "refresh") {
      const revision = await tx.researchReportRevision.findUniqueOrThrow({ where: { runId_revision: { runId: run.id, revision: request.expectedReportRevision } } });
      const document = researchReportDocumentSchema.parse(revision.document);
      for (const entry of document.bibliography.filter((item) => !item.private)) {
        items.push({ kind: "read", idempotencyKey: `read:${inputRevision}:${entry.sourceKey}`, planRevision: run.approvedPlanRevision ?? run.planRevision,
          inputRevision, priority: 3, payload: { kind: "read", sourceKey: entry.sourceKey, refresh: true, requestRevision: inputRevision } });
      }
    }
    await enqueueResearchWorkItems(tx, run.id, items);
    await bumpRunSequence(tx, run.id, { inputManifest: json(next), inputRevision, status: "running", completedAt: null, stopReason: null,
      runDeadlineAt: researchRunDeadline(manifest, researchNow()) });
  });
  await advanceResearchRun(input.runId);
  return readResearchRunDto(input.userId, input.runId, input.request);
}

/** Deletes a finished or never-dispatched run and its evidence. Money records stay with their reservations. */
export async function deleteResearchRun(input: { request: Request; userId: string; runId: string }) {
  await prisma.$transaction(async (tx) => {
    const run = await ownedRunForMutation(tx, input.userId, input.runId, input.request);
    // An unknown outcome keeps its record until settled; deleting it would let expiry refund a request that may have run.
    const inFlight = await tx.researchFundingSegment.count({ where: { runId: run.id, status: { in: ["reserving", "reserved", "unknown"] } } });
    const dispatching = await tx.researchPreviewGeneration.count({ where: { runId: run.id, status: "dispatch_started" } });
    const running = await tx.researchWorkItem.count({ where: { runId: run.id, status: "running" } });
    if (inFlight || dispatching || running) throw refuse(409, "RESEARCH_RUN_ACTIVE", "Cancel the research and wait for in-flight work to finish before deleting.");
    await tx.message.deleteMany({ where: { id: run.assistantMessageId, conversationId: run.conversationId, researchRunId: run.id } });
    await tx.researchPreviewRun.delete({ where: { id: run.id } });
  });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Reads

async function readableRun(userId: string, runId: string, request?: Request) {
  const run = await prisma.researchPreviewRun.findFirst({ where: { id: runId, userId, engineVersion: 2 },
    include: { conversation: { select: { password: true, passwordVersion: true } } } });
  if (!run) throw refuse(404, "RESEARCH_RUN_NOT_FOUND", "Research run not found.");
  if (run.conversation.password != null && !(request && hasConversationUnlockGrant(request, userId, run.conversationId, run.conversation.passwordVersion))) {
    throw refuse(423, "RESEARCH_CONVERSATION_LOCKED", "Unlock this conversation before reading Research.");
  }
  return run;
}

export async function readResearchRunDto(userId: string, runId: string, request?: Request): Promise<ResearchRunV2Dto> {
  const run = await readableRun(userId, runId, request);
  const [plan, items, money, sourceCounts, readCount, unknownGenerations, heldUnknown] = await Promise.all([
    run.planRevision ? prisma.researchPlanRevision.findUnique({ where: { runId_revision: { runId, revision: run.planRevision } } }) : null,
    prisma.researchWorkItem.findMany({ where: { runId }, select: { kind: true, status: true, payload: true, result: true } }),
    readResearchRunMoney(prisma, runId),
    prisma.researchSource.groupBy({ by: ["visibility"], where: { runId }, _count: true }),
    prisma.researchSourceVersion.count({ where: { runId, readStatus: "read" } }),
    prisma.researchPreviewGeneration.count({ where: { runId, status: { in: ["outcome_unknown"] } } }),
    prisma.researchFundingSegment.count({ where: { runId, status: "unknown" } }),
  ]);
  const counts = { queued: 0, running: 0, completed: 0, failed: 0, attention: 0, blocked: 0, cancelled: 0 };
  for (const item of items) {
    const key = item.status === "superseded" ? "cancelled" : item.status;
    if (key in counts) counts[key as keyof typeof counts] += 1;
  }
  const questions = new Map<string, { key: string; question: string; state: "pending" | "active" | "done" | "attention"; findings: number }>();
  let openQuestions: string[] = [];
  for (const item of items.filter((entry) => entry.kind === "investigate")) {
    const payload = item.payload as { questionKey: string; question: string };
    const result = item.result as { findings?: Array<{ resolved?: unknown[] }>; openQuestions?: string[]; done?: boolean } | null;
    const current = questions.get(payload.questionKey) ?? { key: payload.questionKey, question: payload.question, state: "pending" as const, findings: 0 };
    current.findings += (result?.findings ?? []).filter((finding) => (finding.resolved ?? []).length).length;
    if (item.status === "running" || item.status === "queued") current.state = item.status === "running" ? "active" : current.state === "done" ? "active" : current.state;
    if (item.status === "attention" || item.status === "failed") current.state = "attention";
    if (item.status === "completed" && result?.done) current.state = "done";
    if (result?.openQuestions) openQuestions = [...openQuestions, ...result.openQuestions].slice(-10);
    questions.set(payload.questionKey, current);
  }
  const visibility = Object.fromEntries(sourceCounts.map((row) => [row.visibility, row._count]));
  const settlement = unknownGenerations || money.unknownCredits ? "unknown" : money.reservedCredits ? "pending" : "settled";
  const terminal = RESEARCH_RUN_TERMINAL_STATUSES.has(run.status);
  const inFlight = counts.running > 0 || money.reservedCredits > 0;
  const parsedPlan = plan ? researchPlanSchema.safeParse(plan.plan) : null;
  const dto: ResearchRunV2Dto = {
    id: run.id, engineVersion: 2, conversationId: run.conversationId, assistantMessageId: run.assistantMessageId, status: run.status,
    ...(run.stopReason ? { stopReason: run.stopReason } : {}), eventSequence: run.eventSequence, inputRevision: run.inputRevision,
    planRevision: run.planRevision, approvedPlanRevision: run.approvedPlanRevision,
    qualityStatus: (run.qualityStatus as ResearchRunV2Dto["qualityStatus"]) ?? null, currentReportRevision: run.currentReportRevision,
    pauseRequested: Boolean(run.pauseRequestedAt), cancelRequested: Boolean(run.cancelRequestedAt),
    ...(plan && parsedPlan?.success ? { plan: { revision: plan.revision, author: plan.author, plan: parsedPlan.data } } : {}),
    progress: { items: counts, questions: [...questions.values()], sourcesSeen: (visibility.public ?? 0) + (visibility.private ?? 0),
      sourcesRead: readCount, privateSources: visibility.private ?? 0, openQuestions },
    money: { approvedCredits: money.approvedCredits, settledCredits: money.settledCredits, reservedCredits: money.reservedCredits,
      unknownCredits: money.unknownCredits, finalizationReserveCredits: money.finalizationReserveCredits, settlement },
    actions: {
      canPause: ["queued", "running", "finalizing", "planning"].includes(run.status) && !run.pauseRequestedAt && !run.cancelRequestedAt,
      canResume: run.status === "paused" || Boolean(run.pauseRequestedAt && !run.cancelRequestedAt),
      canCancel: !terminal && !run.cancelRequestedAt,
      canExtendBudget: !terminal && !run.cancelRequestedAt,
      canApprovePlan: run.status === "awaiting_input" && !run.approvedPlanRevision && Boolean(parsedPlan?.success),
      canEditPlan: run.status === "awaiting_input" && !run.approvedPlanRevision,
      canRevise: run.status === "completed" && run.currentReportRevision > 0,
      canDelete: (terminal || ["draft", "awaiting_input"].includes(run.status)) && !inFlight && !heldUnknown,
      canFinish: Boolean(run.approvedPlanRevision) && !run.cancelRequestedAt && run.lastErrorCode !== "RESEARCH_FINALIZE_REQUESTED" &&
        ((run.status === "awaiting_input" && run.lastErrorCode === "RESEARCH_RUN_BUDGET_REACHED") || ["queued", "running"].includes(run.status)),
    },
    budgetReached: run.status === "awaiting_input" && run.lastErrorCode === "RESEARCH_RUN_BUDGET_REACHED",
    createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(),
  };
  return dto;
}
