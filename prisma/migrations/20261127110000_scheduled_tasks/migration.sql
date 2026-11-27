-- Scheduled tasks (lib/scheduledTaskCore.ts): a question the server asks on an
-- account's behalf on a schedule, answered into one Chat conversation. Two new
-- tables; no existing row or column is touched.
--
--   ScheduledTask     what the account saved: the question, the model, the
--                     schedule in the account's zone, and the most one run may
--                     reserve (`creditsPerRun`, quoted from Chat pricing and
--                     approved on save).
--   ScheduledTaskRun  one occurrence. (taskId, scheduledFor) is unique, so an
--                     occurrence is claimed once. `runningUserId` is the account
--                     id exactly while the run is running and is unique, so an
--                     account has one scheduled run in flight at a time.
--                     `assistantMessageId` is the Chat attempt identity, derived
--                     from the run id: a second dispatch can only reattach.
--                     `taskRevision` is the task version the run was claimed
--                     for; once a pause or edit moves the task past it, the
--                     reservation guard refuses the run any credit.
--
-- Both cascade from User, so deleting the account deletes them. A task's
-- conversation is SET NULL when the conversation is deleted; the next run
-- starts a new one. Runs cascade with their task.
--
-- Nothing runs until `feature.scheduledTasksEnabled` is "true" (default off).
--
-- The timestamps are TIMESTAMPTZ: every due and lease comparison uses the
-- database clock, and a naive timestamp would move with the session's zone.
--
-- Rollback (nothing else reads these tables):
--   DROP TABLE "ScheduledTaskRun";
--   DROP TABLE "ScheduledTask";
BEGIN;

CREATE TABLE "ScheduledTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "webSearch" BOOLEAN NOT NULL DEFAULT true,
    "frequency" TEXT NOT NULL,
    "timeOfDay" TEXT NOT NULL,
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "runOnDate" TEXT,
    "timeZone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "pauseReason" TEXT,
    "creditsPerRun" INTEGER NOT NULL,
    "nextRunAt" TIMESTAMPTZ(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "conversationId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ScheduledTask_pkey" PRIMARY KEY ("id"),
    -- Never more often than daily: there is no hourly frequency to choose.
    CONSTRAINT "ScheduledTask_frequency_check" CHECK ("frequency" IN ('once', 'daily', 'weekly', 'monthly')),
    CONSTRAINT "ScheduledTask_status_check" CHECK ("status" IN ('active', 'paused', 'completed')),
    CONSTRAINT "ScheduledTask_pauseReason_check" CHECK ("pauseReason" IS NULL OR "pauseReason" IN ('user', 'insufficient_credits', 'cost_changed', 'plan_required', 'model_unavailable', 'conversation_locked', 'account_unavailable', 'storage_full', 'repeated_failures')),
    -- A paused task always says why, and only a paused one does.
    CONSTRAINT "ScheduledTask_pause_shape_check" CHECK (("status" = 'paused') = ("pauseReason" IS NOT NULL)),
    -- Each frequency carries exactly the field it is read with.
    CONSTRAINT "ScheduledTask_schedule_shape_check" CHECK (
        "timeOfDay" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND (("frequency" = 'weekly') = ("dayOfWeek" IS NOT NULL))
        AND ("dayOfWeek" IS NULL OR "dayOfWeek" BETWEEN 0 AND 6)
        AND (("frequency" = 'monthly') = ("dayOfMonth" IS NOT NULL))
        AND ("dayOfMonth" IS NULL OR "dayOfMonth" BETWEEN 1 AND 31)
        AND (("frequency" = 'once') = ("runOnDate" IS NOT NULL))
        AND ("runOnDate" IS NULL OR "runOnDate" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
    ),
    -- The route validates the same bounds (SCHEDULED_TASK_LIMITS); this is the backstop for any other writer.
    CONSTRAINT "ScheduledTask_bounds_check" CHECK (
        char_length("title") BETWEEN 1 AND 80
        AND char_length("prompt") BETWEEN 1 AND 2000
        AND char_length("timeZone") BETWEEN 1 AND 64
        AND "creditsPerRun" >= 0
        AND "consecutiveFailures" >= 0
        AND "revision" >= 1
    )
);

CREATE TABLE "ScheduledTaskRun" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runningUserId" TEXT,
    "taskRevision" INTEGER NOT NULL,
    "scheduledFor" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "outcome" TEXT,
    "conversationId" TEXT,
    "userMessageId" TEXT,
    "assistantMessageId" TEXT NOT NULL,
    "chatReservationId" TEXT,
    "reservedCredits" INTEGER NOT NULL DEFAULT 0,
    "chargedCredits" INTEGER,
    "leaseExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ScheduledTaskRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScheduledTaskRun_status_check" CHECK ("status" IN ('running', 'succeeded', 'failed', 'skipped', 'unknown')),
    -- The one-in-flight slot is held exactly while running, and only by the run's own account.
    CONSTRAINT "ScheduledTaskRun_running_shape_check" CHECK (
        (("status" = 'running') = ("runningUserId" IS NOT NULL))
        AND ("runningUserId" IS NULL OR "runningUserId" = "userId")
        AND (("status" = 'running') = ("finishedAt" IS NULL))
    ),
    -- A short machine code, never provider text or an exception message.
    CONSTRAINT "ScheduledTaskRun_outcome_shape_check" CHECK ("outcome" IS NULL OR "outcome" ~ '^[A-Za-z0-9_]{1,64}$'),
    CONSTRAINT "ScheduledTaskRun_credits_check" CHECK ("reservedCredits" >= 0 AND ("chargedCredits" IS NULL OR "chargedCredits" >= 0)),
    CONSTRAINT "ScheduledTaskRun_taskRevision_check" CHECK ("taskRevision" >= 1)
);

CREATE INDEX "ScheduledTask_status_nextRunAt_idx" ON "ScheduledTask"("status", "nextRunAt");

CREATE INDEX "ScheduledTask_userId_createdAt_idx" ON "ScheduledTask"("userId", "createdAt");

CREATE INDEX "ScheduledTask_conversationId_idx" ON "ScheduledTask"("conversationId");

CREATE UNIQUE INDEX "ScheduledTaskRun_runningUserId_key" ON "ScheduledTaskRun"("runningUserId");

CREATE UNIQUE INDEX "ScheduledTaskRun_assistantMessageId_key" ON "ScheduledTaskRun"("assistantMessageId");

CREATE INDEX "ScheduledTaskRun_userId_startedAt_idx" ON "ScheduledTaskRun"("userId", "startedAt");

CREATE INDEX "ScheduledTaskRun_status_leaseExpiresAt_idx" ON "ScheduledTaskRun"("status", "leaseExpiresAt");

CREATE UNIQUE INDEX "ScheduledTaskRun_taskId_scheduledFor_key" ON "ScheduledTaskRun"("taskId", "scheduledFor");

ALTER TABLE "ScheduledTask" ADD CONSTRAINT "ScheduledTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ScheduledTask" ADD CONSTRAINT "ScheduledTask_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ScheduledTaskRun" ADD CONSTRAINT "ScheduledTaskRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ScheduledTaskRun" ADD CONSTRAINT "ScheduledTaskRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
