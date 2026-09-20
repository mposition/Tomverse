-- Tomverse AMUX development-agent orchestration.
--
-- This migration adds its own task authority rather than reinterpreting
-- FeedbackAutoFixCase or ModelLifecycleWorkItem, whose lifecycle contracts
-- belong to different products.
--
-- Selection does not start execution. An owner claim remains a CAS-protected
-- scheduling mutation; later execution has its own boundary.

CREATE TABLE "AmuxWorkItem" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'todo',
    "kind" TEXT NOT NULL DEFAULT 'unknown',
    "priority" TEXT NOT NULL DEFAULT 'p3',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "drag" INTEGER NOT NULL DEFAULT 0,
    "owner" TEXT,
    "classification" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxWorkItem_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AmuxWorkItem"
    ADD CONSTRAINT "AmuxWorkItem_status_check"
    CHECK ("status" IN ('todo', 'doing', 'review', 'done', 'blocked', 'cancelled'));

ALTER TABLE "AmuxWorkItem"
    ADD CONSTRAINT "AmuxWorkItem_kind_check"
    CHECK ("kind" IN (
        'blocker',
        'escalation',
        'bug',
        'code',
        'ops',
        'investigation',
        'research',
        'chore',
        'doc',
        'unknown'
    ));

ALTER TABLE "AmuxWorkItem"
    ADD CONSTRAINT "AmuxWorkItem_priority_check"
    CHECK ("priority" IN ('p0', 'p1', 'p2', 'p3'));

ALTER TABLE "AmuxWorkItem"
    ADD CONSTRAINT "AmuxWorkItem_drag_check"
    CHECK ("drag" BETWEEN 0 AND 8);

ALTER TABLE "AmuxWorkItem"
    ADD CONSTRAINT "AmuxWorkItem_revision_check"
    CHECK ("revision" >= 0);

CREATE INDEX "AmuxWorkItem_status_owner_archivedAt_createdAt_idx"
    ON "AmuxWorkItem"("status", "owner", "archivedAt", "createdAt");

CREATE INDEX "AmuxWorkItem_priority_createdAt_idx"
    ON "AmuxWorkItem"("priority", "createdAt");

CREATE INDEX "AmuxWorkItem_owner_status_idx"
    ON "AmuxWorkItem"("owner", "status");


CREATE TABLE "AmuxWorkDependency" (
    "taskId" TEXT NOT NULL,
    "dependencyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxWorkDependency_pkey"
        PRIMARY KEY ("taskId", "dependencyId"),

    CONSTRAINT "AmuxWorkDependency_not_self_check"
        CHECK ("taskId" <> "dependencyId")
);

ALTER TABLE "AmuxWorkDependency"
    ADD CONSTRAINT "AmuxWorkDependency_taskId_fkey"
    FOREIGN KEY ("taskId")
    REFERENCES "AmuxWorkItem"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

ALTER TABLE "AmuxWorkDependency"
    ADD CONSTRAINT "AmuxWorkDependency_dependencyId_fkey"
    FOREIGN KEY ("dependencyId")
    REFERENCES "AmuxWorkItem"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

CREATE INDEX "AmuxWorkDependency_dependencyId_taskId_idx"
    ON "AmuxWorkDependency"("dependencyId", "taskId");


CREATE TABLE "AmuxRouteDecision" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "worker" TEXT NOT NULL,
    "schedulerScore" INTEGER NOT NULL,
    "scoringVersion" TEXT NOT NULL,
    "taskRevision" INTEGER NOT NULL,
    "signals" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxRouteDecision_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AmuxRouteDecision"
    ADD CONSTRAINT "AmuxRouteDecision_taskId_fkey"
    FOREIGN KEY ("taskId")
    REFERENCES "AmuxWorkItem"("id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE;

ALTER TABLE "AmuxRouteDecision"
    ADD CONSTRAINT "AmuxRouteDecision_taskRevision_check"
    CHECK ("taskRevision" >= 0);

CREATE INDEX "AmuxRouteDecision_taskId_createdAt_idx"
    ON "AmuxRouteDecision"("taskId", "createdAt");

CREATE INDEX "AmuxRouteDecision_worker_createdAt_idx"
    ON "AmuxRouteDecision"("worker", "createdAt");

CREATE INDEX "AmuxRouteDecision_scoringVersion_createdAt_idx"
    ON "AmuxRouteDecision"("scoringVersion", "createdAt");


-- Routing decisions are evidence, not mutable state. Work-item ownership may
-- advance; the decision that caused an earlier claim must not be rewritten.
CREATE FUNCTION amux_route_decision_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'AmuxRouteDecision is append-only';
END;
$$;

CREATE TRIGGER "AmuxRouteDecision_reject_update"
BEFORE UPDATE ON "AmuxRouteDecision"
FOR EACH ROW
EXECUTE FUNCTION amux_route_decision_append_only_guard();

CREATE TRIGGER "AmuxRouteDecision_reject_delete"
BEFORE DELETE ON "AmuxRouteDecision"
FOR EACH ROW
EXECUTE FUNCTION amux_route_decision_append_only_guard();
