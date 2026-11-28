import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { isImageGenerationEnabledCached } from "@/lib/appSettings";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import { APP_MANAGED_SEARCH_MAX_STEPS } from "@/lib/chatAttemptExecution";
import { buildChatTurnSystemBlocks } from "@/lib/chatTurnSystemBlocks";
import { GENERATED_ARTIFACT_MAX_STEPS } from "@/lib/generatedArtifactTool";
import { planAllowsImageGeneration } from "@/lib/imageGenerationAccess";
import {
  assertModelAccess,
  createChatBudget,
  identifyChatCaller,
  isChatAccessError,
} from "@/lib/chatSecurity";
import { atLeastOneToken, createTokenEstimateAccumulator } from "@/lib/chatTokenEstimate";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { isPubliclySelectableModel } from "@/lib/models";
import { prisma } from "@/lib/prisma";
import {
  nextOccurrence,
  planRunsScheduledTasks,
  scheduleProblem,
  SCHEDULED_TASK_FREQUENCIES,
  SCHEDULED_TASK_LIMITS,
  type ScheduledTaskPauseReason,
  type ScheduledTaskSchedule,
} from "@/lib/scheduledTaskCore";
import { isScheduledTasksEnabled } from "@/lib/scheduledTaskSettings";
import { normalizeIanaTimeZone } from "@/lib/userTimeZone";
import { resolveWebSearchBackendReadiness } from "@/lib/webSearchBackendRuntime";
import {
  appManagedSearchIsDispatchable,
  getWebSearchCapability,
  nativeSearchIsDispatchable,
} from "@/lib/webSearchCapability";
import { refreshSearchQueryCeilingBreaches } from "@/lib/webSearchCeilingBreachStore";
import { getWebSearchSurchargeCredits } from "@/lib/webSearchCredits";
import { reserveTurnSearchCost } from "@/lib/webSearchNativeCostReservation";

export class ScheduledTaskError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>
  ) {
    super(code);
    this.name = "ScheduledTaskError";
  }
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const scheduledTaskInputSchema = z
  .object({
    title: z.string().trim().min(1).max(SCHEDULED_TASK_LIMITS.titleCharacters),
    prompt: z.string().trim().min(1).max(SCHEDULED_TASK_LIMITS.promptCharacters),
    modelId: z.string().min(1).max(100),
    webSearch: z.boolean(),
    /** Email the account when a run answers or the task pauses. Omitted means on. */
    emailOnFinish: z.boolean().default(true),
    frequency: z.enum(SCHEDULED_TASK_FREQUENCIES),
    timeOfDay: z.string().regex(TIME),
    dayOfWeek: z.number().int().min(0).max(6).nullable().default(null),
    dayOfMonth: z.number().int().min(1).max(31).nullable().default(null),
    runOnDate: z.string().regex(DATE).nullable().default(null),
    /** The per-run credits the person was shown; absent asks for the quote. */
    confirmCredits: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();
export type ScheduledTaskInput = z.infer<typeof scheduledTaskInputSchema>;

export const scheduledTaskUpdateSchema = z.union([
  scheduledTaskInputSchema.extend({ expectedRevision: z.number().int().min(1) }).strict(),
  z
    .object({
      action: z.enum(["pause", "resume"]),
      expectedRevision: z.number().int().min(1),
      confirmCredits: z.number().int().min(0).max(1_000_000).optional(),
    })
    .strict(),
]);

/** The public shape. Internal ids of runs, reservations and leases are not part of it. */
export type ScheduledTaskView = {
  id: string;
  title: string;
  prompt: string;
  modelId: string;
  webSearch: boolean;
  emailOnFinish: boolean;
  frequency: string;
  timeOfDay: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  runOnDate: string | null;
  timeZone: string;
  status: string;
  pauseReason: string | null;
  creditsPerRun: number;
  nextRunAt: string | null;
  conversationId: string | null;
  revision: number;
  lastRun: {
    status: string;
    outcome: string | null;
    scheduledFor: string;
    finishedAt: string | null;
    chargedCredits: number | null;
    conversationId: string | null;
  } | null;
};

const TASK_SELECT = {
  id: true,
  title: true,
  prompt: true,
  modelId: true,
  webSearch: true,
  emailOnFinish: true,
  frequency: true,
  timeOfDay: true,
  dayOfWeek: true,
  dayOfMonth: true,
  runOnDate: true,
  timeZone: true,
  status: true,
  pauseReason: true,
  creditsPerRun: true,
  nextRunAt: true,
  conversationId: true,
  revision: true,
  runs: {
    orderBy: { scheduledFor: "desc" },
    take: 1,
    select: {
      status: true,
      outcome: true,
      scheduledFor: true,
      finishedAt: true,
      chargedCredits: true,
      conversationId: true,
    },
  },
} satisfies Prisma.ScheduledTaskSelect;

type TaskRow = Prisma.ScheduledTaskGetPayload<{ select: typeof TASK_SELECT }>;

const toView = (row: TaskRow): ScheduledTaskView => {
  const run = row.runs[0];
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    modelId: row.modelId,
    webSearch: row.webSearch,
    emailOnFinish: row.emailOnFinish,
    frequency: row.frequency,
    timeOfDay: row.timeOfDay,
    dayOfWeek: row.dayOfWeek,
    dayOfMonth: row.dayOfMonth,
    runOnDate: row.runOnDate,
    timeZone: row.timeZone,
    status: row.status,
    pauseReason: row.pauseReason,
    creditsPerRun: row.creditsPerRun,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    conversationId: row.conversationId,
    revision: row.revision,
    lastRun: run
      ? {
          status: run.status,
          outcome: run.outcome,
          scheduledFor: run.scheduledFor.toISOString(),
          finishedAt: run.finishedAt?.toISOString() ?? null,
          chargedCredits: run.chargedCredits,
          conversationId: run.conversationId,
        }
      : null,
  };
};

const INTERNAL_REQUEST_URL = "https://scheduled-task.invalid/";

/**
 * What one run of this question costs, in credits, by Chat's own pricing.
 *
 * The same budget `/api/chat/availability` quotes for a composer draft: the
 * question text, the model, and web search's surcharge and per-query
 * reservation when search is on. Nothing here is a new price -- it is
 * `createChatBudget` with the inputs a scheduled run will send -- and it is
 * the number the person approves on save and the reservation guard holds a
 * run to.
 */
export async function quoteScheduledRunCredits(input: {
  userId: string;
  modelId: string;
  prompt: string;
  webSearch: boolean;
}): Promise<number> {
  const [models, plan] = await Promise.all([getRuntimeModels(), getUserBillingPlan(input.userId)]);
  const model = models.find((candidate) => candidate.id === input.modelId);
  if (!model || !isPubliclySelectableModel(model) || model.usageClass === "deep-research") {
    throw new ScheduledTaskError(400, "MODEL_NOT_AVAILABLE");
  }
  const access = identifyChatCaller(new Request(INTERNAL_REQUEST_URL), input.userId, plan.tier, {
    dailyMessageLimit: plan.dailyMessageLimit,
    monthlyMessageLimit: plan.monthlyMessageLimit,
  });
  try {
    assertModelAccess(access, model);
  } catch (error) {
    if (isChatAccessError(error)) throw new ScheduledTaskError(403, "MODEL_ACCESS_FORBIDDEN");
    throw error;
  }
  const webSearchMode = input.webSearch ? "always" : "off";
  await refreshSearchQueryCeilingBreaches();
  const readiness = resolveWebSearchBackendReadiness();
  const capability = getWebSearchCapability(model);
  const nativeSearchEnabled = webSearchMode === "always" && nativeSearchIsDispatchable(capability);
  const appManagedSearchEnabled =
    webSearchMode === "always" && appManagedSearchIsDispatchable(capability, readiness);
  const search = reserveTurnSearchCost({ model, capability, nativeSearchEnabled, appManagedSearchEnabled });
  if (!search.ok) throw new ScheduledTaskError(409, "WEB_SEARCH_UNAVAILABLE");
  // The input the Chat route prices for the turn the runner sends: its one
  // question plus the capability blocks of the same builder, given the inputs
  // the route derives for that turn (signed in, persisted, no attachment, no
  // location, no context bundle, not Auto-routed), and the same budget
  // options. Pricing the question alone quoted less than the route reserved,
  // so a task could be paused by its own first run (review
  // r-20261127-050400-76af2f). tests/integration/scheduled-task-chat-route.db.test.ts
  // holds the route's reservation to this figure.
  const blocks = buildChatTurnSystemBlocks({
    currentLocation: null,
    modelId: model.id,
    provider: model.provider,
    usageClass: model.usageClass,
    fileToolsOverride: model.fileToolsOverride ?? null,
    autoRouted: false,
    isDeepResearchTurn: false,
    isAuthenticated: true,
    canPersist: true,
    nativeSearchEnabled,
    nativeSearchForced: nativeSearchEnabled && capability.canForceExecution,
    appManagedSearchEnabled,
    turnAttachments: [],
    imageGenerationFlagEnabled: await isImageGenerationEnabledCached(),
    planAllowsImageGeneration: planAllowsImageGeneration(plan.tier),
  });
  const estimate = createTokenEstimateAccumulator().addText(input.prompt);
  if (blocks.promptTokens > 0) estimate.addTokens(blocks.promptTokens);
  const budget = createChatBudget(
    access.kind,
    model,
    atLeastOneToken(estimate.breakdown()),
    {
      webSearchSurchargeCredits: getWebSearchSurchargeCredits(webSearchMode, capability, readiness),
      nativeSearchEnabled,
      appManagedSearchEnabled,
      nativeSearch: search.native,
      searchBackend: search.searchBackend,
      promptCachePath: nativeSearchEnabled ? "chat_turn_native_search" : "chat_turn",
      longContextToolInputPasses: Math.max(
        blocks.artifactPlan?.registerTool ? GENERATED_ARTIFACT_MAX_STEPS : 1,
        appManagedSearchEnabled && capability.searchBackend ? APP_MANAGED_SEARCH_MAX_STEPS : 1
      ),
    }
  );
  return budget.usageCredits;
}

export type ScheduledTaskAvailability = {
  enabled: boolean;
  planAllowed: boolean;
};

export async function scheduledTaskAvailability(userId: string): Promise<ScheduledTaskAvailability> {
  const [enabled, plan] = await Promise.all([isScheduledTasksEnabled(), getUserBillingPlan(userId)]);
  return { enabled, planAllowed: planRunsScheduledTasks(plan.tier) };
}

const assertCanSchedule = async (userId: string) => {
  const availability = await scheduledTaskAvailability(userId);
  if (!availability.enabled) throw new ScheduledTaskError(503, "SCHEDULED_TASKS_UNAVAILABLE");
  if (!availability.planAllowed) throw new ScheduledTaskError(403, "PLAN_REQUIRED");
};

export async function listScheduledTasks(userId: string) {
  const rows = await prisma.scheduledTask.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    take: SCHEDULED_TASK_LIMITS.maxTasks,
    select: TASK_SELECT,
  });
  return rows.map(toView);
}

const scheduleFrom = (input: ScheduledTaskInput, timeZone: string): ScheduledTaskSchedule => ({
  frequency: input.frequency,
  timeOfDay: input.timeOfDay,
  dayOfWeek: input.frequency === "weekly" ? input.dayOfWeek : null,
  dayOfMonth: input.frequency === "monthly" ? input.dayOfMonth : null,
  runOnDate: input.frequency === "once" ? input.runOnDate : null,
  timeZone,
});

const accountTimeZone = async (userId: string) => {
  const settings = await prisma.userSettings.findUnique({ where: { userId }, select: { timeZone: true } });
  return normalizeIanaTimeZone(settings?.timeZone);
};

/** The quote, and a refusal unless the person confirmed exactly it. */
const approvedCredits = async (userId: string, input: { modelId: string; prompt: string; webSearch: boolean; confirmCredits?: number }) => {
  const credits = await quoteScheduledRunCredits({ userId, ...input });
  if (input.confirmCredits !== credits) {
    throw new ScheduledTaskError(409, "CREDITS_CONFIRMATION_REQUIRED", { creditsPerRun: credits });
  }
  return credits;
};

const validSchedule = (schedule: ScheduledTaskSchedule, now: Date) => {
  const problem = scheduleProblem(schedule);
  if (problem) throw new ScheduledTaskError(400, "SCHEDULE_INVALID", { problem });
  const next = nextOccurrence(schedule, now);
  if (!next) throw new ScheduledTaskError(400, "SCHEDULE_IN_PAST");
  return next;
};

const lockAccountTasks = (tx: Prisma.TransactionClient, userId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`scheduled-tasks:${userId}`}))`;

const assertActiveCapacity = async (tx: Prisma.TransactionClient, userId: string, excludingTaskId?: string) => {
  const active = await tx.scheduledTask.count({
    where: { userId, status: "active", ...(excludingTaskId ? { id: { not: excludingTaskId } } : {}) },
  });
  if (active >= SCHEDULED_TASK_LIMITS.maxActiveTasks) {
    throw new ScheduledTaskError(409, "ACTIVE_TASK_LIMIT", { limit: SCHEDULED_TASK_LIMITS.maxActiveTasks });
  }
};

export async function createScheduledTask(userId: string, input: ScheduledTaskInput, now = new Date()) {
  await assertCanSchedule(userId);
  const timeZone = await accountTimeZone(userId);
  const schedule = scheduleFrom(input, timeZone);
  const nextRunAt = validSchedule(schedule, now);
  const creditsPerRun = await approvedCredits(userId, input);
  const created = await prisma.$transaction(async (tx) => {
    await lockAccountTasks(tx, userId);
    if ((await tx.scheduledTask.count({ where: { userId } })) >= SCHEDULED_TASK_LIMITS.maxTasks) {
      throw new ScheduledTaskError(409, "TASK_LIMIT", { limit: SCHEDULED_TASK_LIMITS.maxTasks });
    }
    await assertActiveCapacity(tx, userId);
    return tx.scheduledTask.create({
      data: {
        userId,
        title: input.title,
        prompt: input.prompt,
        modelId: input.modelId,
        webSearch: input.webSearch,
        emailOnFinish: input.emailOnFinish,
        ...schedule,
        status: "active",
        creditsPerRun,
        nextRunAt,
      },
      select: TASK_SELECT,
    });
  });
  return toView(created);
}

const ownedTask = async (tx: Prisma.TransactionClient, userId: string, taskId: string, expectedRevision: number) => {
  const rows = await tx.$queryRaw<Array<{ id: string; status: string; revision: number; frequency: string; timeOfDay: string;
    dayOfWeek: number | null; dayOfMonth: number | null; runOnDate: string | null; timeZone: string;
    modelId: string; prompt: string; webSearch: boolean; creditsPerRun: number }>>`
    SELECT "id", "status", "revision", "frequency", "timeOfDay", "dayOfWeek", "dayOfMonth", "runOnDate", "timeZone",
           "modelId", "prompt", "webSearch", "creditsPerRun"
    FROM "ScheduledTask" WHERE "id" = ${taskId} AND "userId" = ${userId} FOR UPDATE`;
  const task = rows[0];
  if (!task) throw new ScheduledTaskError(404, "TASK_NOT_FOUND");
  if (task.revision !== expectedRevision) throw new ScheduledTaskError(409, "TASK_CHANGED");
  return task;
};

export async function updateScheduledTask(
  userId: string,
  taskId: string,
  input: ScheduledTaskInput & { expectedRevision: number },
  now = new Date()
) {
  await assertCanSchedule(userId);
  const timeZone = await accountTimeZone(userId);
  const schedule = scheduleFrom(input, timeZone);
  const nextRunAt = validSchedule(schedule, now);
  const creditsPerRun = await approvedCredits(userId, input);
  const updated = await prisma.$transaction(async (tx) => {
    await lockAccountTasks(tx, userId);
    const task = await ownedTask(tx, userId, taskId, input.expectedRevision);
    // A finished one-off with a new future time is scheduled again; a paused
    // task stays paused until the person resumes it.
    const status = task.status === "completed" ? "active" : task.status;
    if (status === "active" && task.status !== "active") await assertActiveCapacity(tx, userId, taskId);
    return tx.scheduledTask.update({
      where: { id: taskId },
      data: {
        title: input.title,
        prompt: input.prompt,
        modelId: input.modelId,
        webSearch: input.webSearch,
        emailOnFinish: input.emailOnFinish,
        ...schedule,
        status,
        ...(status === "active" ? { pauseReason: null } : {}),
        creditsPerRun,
        nextRunAt: status === "active" ? nextRunAt : null,
        consecutiveFailures: 0,
        revision: { increment: 1 },
      },
      select: TASK_SELECT,
    });
  });
  return toView(updated);
}

export async function pauseScheduledTask(userId: string, taskId: string, expectedRevision: number) {
  const updated = await prisma.$transaction(async (tx) => {
    const task = await ownedTask(tx, userId, taskId, expectedRevision);
    if (task.status !== "active") throw new ScheduledTaskError(409, "TASK_NOT_ACTIVE");
    return tx.scheduledTask.update({
      where: { id: taskId },
      data: { status: "paused", pauseReason: "user" satisfies ScheduledTaskPauseReason, nextRunAt: null, revision: { increment: 1 } },
      select: TASK_SELECT,
    });
  });
  return toView(updated);
}

/**
 * Resuming re-quotes the run. A price that went up since the task was saved --
 * the reason a task pauses as `cost_changed` -- needs the person to approve the
 * new figure; an unchanged or lower one does not.
 */
export async function resumeScheduledTask(
  userId: string,
  taskId: string,
  expectedRevision: number,
  confirmCredits: number | undefined,
  now = new Date()
) {
  await assertCanSchedule(userId);
  const current = await prisma.scheduledTask.findFirst({
    where: { id: taskId, userId },
    select: { modelId: true, prompt: true, webSearch: true, creditsPerRun: true, revision: true },
  });
  if (!current) throw new ScheduledTaskError(404, "TASK_NOT_FOUND");
  // The quote is of the version the person is resuming; the transaction below
  // checks the same revision again under the row lock.
  if (current.revision !== expectedRevision) throw new ScheduledTaskError(409, "TASK_CHANGED");
  const quoted = await quoteScheduledRunCredits({ userId, modelId: current.modelId, prompt: current.prompt, webSearch: current.webSearch });
  if (quoted > current.creditsPerRun && confirmCredits !== quoted) {
    throw new ScheduledTaskError(409, "CREDITS_CONFIRMATION_REQUIRED", { creditsPerRun: quoted });
  }
  const updated = await prisma.$transaction(async (tx) => {
    await lockAccountTasks(tx, userId);
    const task = await ownedTask(tx, userId, taskId, expectedRevision);
    if (task.status === "active") throw new ScheduledTaskError(409, "TASK_ALREADY_ACTIVE");
    const nextRunAt = nextOccurrence(
      {
        frequency: task.frequency as ScheduledTaskSchedule["frequency"],
        timeOfDay: task.timeOfDay,
        dayOfWeek: task.dayOfWeek,
        dayOfMonth: task.dayOfMonth,
        runOnDate: task.runOnDate,
        timeZone: task.timeZone,
      },
      now
    );
    if (!nextRunAt) throw new ScheduledTaskError(400, "SCHEDULE_IN_PAST");
    await assertActiveCapacity(tx, userId, taskId);
    return tx.scheduledTask.update({
      where: { id: taskId },
      data: {
        status: "active",
        pauseReason: null,
        nextRunAt,
        consecutiveFailures: 0,
        creditsPerRun: Math.max(quoted, task.creditsPerRun),
        revision: { increment: 1 },
      },
      select: TASK_SELECT,
    });
  });
  return toView(updated);
}

export async function deleteScheduledTask(userId: string, taskId: string) {
  const deleted = await prisma.scheduledTask.deleteMany({ where: { id: taskId, userId } });
  if (!deleted.count) throw new ScheduledTaskError(404, "TASK_NOT_FOUND");
}
