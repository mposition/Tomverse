-- Support-triage groups, memberships and signals (docs/policy/support-triage.md §5, §6).
--
-- A group is one equivalence class of one kind: every member shares the
-- group's primary snapshot digest, which is the SHA-256 of a server value
-- (never the value, never a report's text). This migration writes no row.
--
-- What the database enforces:
--
--   * a group is born candidate, undecided, unqueued, with a key and a primary
--     digest; its kind and creation time never change;
--   * the state moves only along the transitions block below. An open group
--     (candidate, confirmed) holds a primary digest; a terminal one does not,
--     and the digest only ever goes from a value to NULL, with the move to a
--     terminal state;
--   * a member names its group together with the group's digest (composite
--     foreign key), so no member can disagree with its group and a terminal
--     group can hold no member: ending a group with members still present
--     fails. Ending it with signals still present fails too. The order is
--     therefore members, then signals, then the group;
--   * a report is a member of at most one group, at most fifty members per
--     group, and no member or signal is added for a deleted account's report
--     or to a terminal group;
--   * ending a group stamps keyRetiredAt and may record the departing member
--     ids (at most fifty); the key and that list are the tombstone, cleared
--     together and only after the seven-day cooldown, and nothing else about
--     a terminal group ever changes;
--   * a decision is written only with the move it decides, stamped by the
--     database; displayed is reached once, from not_queued, while candidate;
--   * members and signals are inserted and deleted, never updated.
--
-- Time is the database's: clock_timestamp() AT TIME ZONE 'UTC', read once per
-- trigger call. Every function pins search_path and has no EXCEPTION handler.

BEGIN;

CREATE TABLE "SupportTriageGroup" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'candidate',
    "primaryKind" TEXT NOT NULL,
    "primarySnapshotDigest" TEXT,
    "groupCandidateKey" TEXT,
    "groupInputDigest" TEXT,
    "keyRetiredAt" TIMESTAMP(3),
    "retiredMemberIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "decision" TEXT,
    "decidedAt" TIMESTAMP(3),
    "ownerQueueState" TEXT NOT NULL DEFAULT 'not_queued',
    "displayedAt" TIMESTAMP(3),
    "keyRecheckDeferredCount" INTEGER NOT NULL DEFAULT 0,
    "keyRecheckDeferredRunId" TEXT,
    "keyRecheckLastEvaluatedRunSeq" BIGINT,
    "keyRecheckDeferredRunSeq" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportTriageGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupportTriageGroup_groupCandidateKey_key" ON "SupportTriageGroup"("groupCandidateKey");

CREATE UNIQUE INDEX "SupportTriageGroup_id_primarySnapshotDigest_key" ON "SupportTriageGroup"("id", "primarySnapshotDigest");

CREATE INDEX "SupportTriageGroup_state_ownerQueueState_createdAt_idx" ON "SupportTriageGroup"("state", "ownerQueueState", "createdAt");

CREATE INDEX "SupportTriageGroup_keyRetiredAt_idx" ON "SupportTriageGroup"("keyRetiredAt");

-- Account deletion finds terminal groups by a departed member's id.
CREATE INDEX "SupportTriageGroup_retiredMemberIds_idx" ON "SupportTriageGroup" USING GIN ("retiredMemberIds");

ALTER TABLE "SupportTriageGroup"
    ADD CONSTRAINT "SupportTriageGroup_state_check"
        CHECK ("state" IN ('candidate', 'confirmed', 'dismissed', 'expired', 'invalidated')),
    ADD CONSTRAINT "SupportTriageGroup_primaryKind_check"
        CHECK ("primaryKind" IN ('server_evidence_match', 'same_account', 'autofix_fingerprint')),
    ADD CONSTRAINT "SupportTriageGroup_decision_check"
        CHECK ("decision" IS NULL OR "decision" IN ('confirmed', 'dismissed')),
    ADD CONSTRAINT "SupportTriageGroup_ownerQueueState_check"
        CHECK ("ownerQueueState" IN ('not_queued', 'displayed')),
    -- Open groups hold the primary digest; terminal ones do not. state is NOT
    -- NULL, so the left side is never NULL: two of the four combinations pass.
    ADD CONSTRAINT "SupportTriageGroup_primary_digest_open_check"
        CHECK (("state" IN ('candidate', 'confirmed')) = ("primarySnapshotDigest" IS NOT NULL)),
    ADD CONSTRAINT "SupportTriageGroup_primarySnapshotDigest_check"
        CHECK ("primarySnapshotDigest" IS NULL OR "primarySnapshotDigest" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "SupportTriageGroup_groupCandidateKey_check"
        CHECK ("groupCandidateKey" IS NULL OR "groupCandidateKey" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "SupportTriageGroup_groupInputDigest_check"
        CHECK ("groupInputDigest" IS NULL OR "groupInputDigest" ~ '^[0-9a-f]{64}$'),
    -- An open group has a key; a terminal one keeps it until the cooldown ends.
    ADD CONSTRAINT "SupportTriageGroup_key_open_check"
        CHECK ("state" NOT IN ('candidate', 'confirmed') OR "groupCandidateKey" IS NOT NULL),
    ADD CONSTRAINT "SupportTriageGroup_keyRetiredAt_check"
        CHECK (("state" IN ('dismissed', 'expired', 'invalidated')) = ("keyRetiredAt" IS NOT NULL)),
    -- limit: GROUP_RETIRED_MEMBER_IDS_MAX
    ADD CONSTRAINT "SupportTriageGroup_retiredMemberIds_check"
        CHECK ("retiredMemberIds" IS NOT NULL AND pg_catalog.cardinality("retiredMemberIds") <= 50),
    ADD CONSTRAINT "SupportTriageGroup_retiredMemberIds_terminal_check"
        CHECK (pg_catalog.cardinality("retiredMemberIds") = 0 OR "state" IN ('dismissed', 'expired', 'invalidated')),
    -- The tombstone is the key and the list together.
    ADD CONSTRAINT "SupportTriageGroup_tombstone_check"
        CHECK ("groupCandidateKey" IS NOT NULL OR pg_catalog.cardinality("retiredMemberIds") = 0),
    ADD CONSTRAINT "SupportTriageGroup_decided_check"
        CHECK (("decision" IS NULL) = ("decidedAt" IS NULL)),
    -- A decided state carries its decision; an undecided one carries none. An
    -- invalidated group keeps whatever it had. IS NOT DISTINCT FROM, not =:
    -- a NULL decision must fail, and a CHECK passes on NULL.
    ADD CONSTRAINT "SupportTriageGroup_decision_state_check"
        CHECK (CASE "state"
                   WHEN 'candidate' THEN "decision" IS NULL
                   WHEN 'confirmed' THEN "decision" IS NOT DISTINCT FROM 'confirmed'
                   WHEN 'dismissed' THEN "decision" IS NOT DISTINCT FROM 'dismissed'
                   WHEN 'expired' THEN "decision" IS NULL
                   ELSE TRUE
               END),
    ADD CONSTRAINT "SupportTriageGroup_displayed_check"
        CHECK (("ownerQueueState" = 'displayed') = ("displayedAt" IS NOT NULL)),
    -- limit: GROUP_KEY_RECHECK_DEFERRAL_LIMIT
    ADD CONSTRAINT "SupportTriageGroup_keyRecheckDeferredCount_check"
        CHECK ("keyRecheckDeferredCount" BETWEEN 0 AND 3);

CREATE TABLE "SupportTriageGroupMember" (
    "groupId" TEXT NOT NULL,
    "feedbackId" TEXT NOT NULL,
    "primarySnapshotDigest" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportTriageGroupMember_pkey" PRIMARY KEY ("groupId", "feedbackId")
);

-- Members exist only in open groups (the composite key below), so one row per
-- report is one open group per report. A move deletes before it inserts.
CREATE UNIQUE INDEX "SupportTriageGroupMember_feedbackId_key" ON "SupportTriageGroupMember"("feedbackId");

ALTER TABLE "SupportTriageGroupMember" ADD CONSTRAINT "SupportTriageGroupMember_group_digest_fkey" FOREIGN KEY ("groupId", "primarySnapshotDigest") REFERENCES "SupportTriageGroup"("id", "primarySnapshotDigest") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "SupportTriageGroupMember" ADD CONSTRAINT "SupportTriageGroupMember_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "Feedback"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE TABLE "SupportTriageGroupSignal" (
    "groupId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "snapshotDigest" TEXT NOT NULL,
    "provenanceClass" TEXT NOT NULL,
    "snapshotExpiresAt" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportTriageGroupSignal_pkey" PRIMARY KEY ("groupId", "kind")
);

CREATE INDEX "SupportTriageGroupSignal_snapshotExpiresAt_idx" ON "SupportTriageGroupSignal"("snapshotExpiresAt");

ALTER TABLE "SupportTriageGroupSignal" ADD CONSTRAINT "SupportTriageGroupSignal_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SupportTriageGroup"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "SupportTriageGroupSignal"
    ADD CONSTRAINT "SupportTriageGroupSignal_kind_check"
        CHECK ("kind" IN ('server_evidence_match', 'same_account', 'autofix_fingerprint')),
    ADD CONSTRAINT "SupportTriageGroupSignal_provenanceClass_check"
        CHECK ("provenanceClass" IN ('server_evidence', 'account_derived', 'autofix_derived')),
    -- The provenance follows from the kind. kind is NOT NULL and the CASE
    -- covers every kind, so the right side is never NULL.
    ADD CONSTRAINT "SupportTriageGroupSignal_provenance_kind_check"
        CHECK ("provenanceClass" = CASE "kind"
                   WHEN 'server_evidence_match' THEN 'server_evidence'
                   WHEN 'same_account' THEN 'account_derived'
                   WHEN 'autofix_fingerprint' THEN 'autofix_derived'
               END),
    ADD CONSTRAINT "SupportTriageGroupSignal_snapshotDigest_check"
        CHECK ("snapshotDigest" ~ '^[0-9a-f]{64}$');

CREATE OR REPLACE FUNCTION "support_triage_group_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    now_utc TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
    -- limit: GROUP_KEY_TOMBSTONE_DAYS
    cooldown CONSTANT INTERVAL := interval '7 days';
    has_signals BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."state" <> 'candidate' OR NEW."decision" IS NOT NULL OR NEW."decidedAt" IS NOT NULL
            OR NEW."keyRetiredAt" IS NOT NULL OR NEW."retiredMemberIds" IS DISTINCT FROM ARRAY[]::TEXT[]
            OR NEW."ownerQueueState" <> 'not_queued' OR NEW."displayedAt" IS NOT NULL
            OR NEW."keyRecheckDeferredCount" <> 0 OR NEW."keyRecheckDeferredRunId" IS NOT NULL
            OR NEW."keyRecheckLastEvaluatedRunSeq" IS NOT NULL OR NEW."keyRecheckDeferredRunSeq" IS NOT NULL THEN
            RAISE EXCEPTION 'SupportTriageGroup must be inserted as an undecided, unqueued candidate'
                USING ERRCODE = 'check_violation';
        END IF;
        NEW."createdAt" := now_utc;
        NEW."updatedAt" := now_utc;
        RETURN NEW;
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."primaryKind" IS DISTINCT FROM OLD."primaryKind"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'SupportTriageGroup id, kind and creation time are immutable'
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."state" IN ('dismissed', 'expired', 'invalidated') THEN
        -- The only write a terminal group takes: clearing its tombstone, the
        -- key and the departed member ids together, once the cooldown is over.
        IF NOT (NEW."groupCandidateKey" IS NULL AND NEW."retiredMemberIds" = ARRAY[]::TEXT[]
                AND OLD."groupCandidateKey" IS NOT NULL
                AND NEW."state" = OLD."state"
                AND NEW."primarySnapshotDigest" IS NOT DISTINCT FROM OLD."primarySnapshotDigest"
                AND NEW."groupInputDigest" IS NOT DISTINCT FROM OLD."groupInputDigest"
                AND NEW."keyRetiredAt" IS NOT DISTINCT FROM OLD."keyRetiredAt"
                AND NEW."decision" IS NOT DISTINCT FROM OLD."decision"
                AND NEW."decidedAt" IS NOT DISTINCT FROM OLD."decidedAt"
                AND NEW."ownerQueueState" IS NOT DISTINCT FROM OLD."ownerQueueState"
                AND NEW."displayedAt" IS NOT DISTINCT FROM OLD."displayedAt"
                AND NEW."keyRecheckDeferredCount" IS NOT DISTINCT FROM OLD."keyRecheckDeferredCount"
                AND NEW."keyRecheckDeferredRunId" IS NOT DISTINCT FROM OLD."keyRecheckDeferredRunId"
                AND NEW."keyRecheckLastEvaluatedRunSeq" IS NOT DISTINCT FROM OLD."keyRecheckLastEvaluatedRunSeq"
                AND NEW."keyRecheckDeferredRunSeq" IS NOT DISTINCT FROM OLD."keyRecheckDeferredRunSeq") THEN
            RAISE EXCEPTION 'SupportTriageGroup % is terminal', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        IF OLD."keyRetiredAt" > now_utc - cooldown THEN
            RAISE EXCEPTION 'SupportTriageGroup % tombstone is inside its cooldown', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        NEW."updatedAt" := now_utc;
        RETURN NEW;
    END IF;

    IF NEW."state" IS DISTINCT FROM OLD."state" THEN
        IF (OLD."state", NEW."state") NOT IN (
            -- transitions: SupportTriageGroup state
            ('candidate', 'confirmed'),
            ('candidate', 'dismissed'),
            ('candidate', 'expired'),
            ('candidate', 'invalidated'),
            ('confirmed', 'invalidated')
            -- end transitions
        ) THEN
            RAISE EXCEPTION 'SupportTriageGroup % cannot go from % to %', OLD."id", OLD."state", NEW."state"
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- The decision is written with the move it decides, and only then.
    IF NEW."decision" IS DISTINCT FROM OLD."decision" OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt" THEN
        IF NOT (OLD."state" = 'candidate' AND NEW."state" IN ('confirmed', 'dismissed')
                AND NEW."decision" = NEW."state") THEN
            RAISE EXCEPTION 'SupportTriageGroup % decision is written only with the decided move', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        NEW."decidedAt" := now_utc;
    END IF;

    IF NEW."state" IN ('dismissed', 'expired', 'invalidated') THEN
        -- Ending a group: members are already gone (the composite key would
        -- refuse this row otherwise) and signals must be gone too.
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I."SupportTriageGroupSignal" s WHERE s."groupId" = $1)',
            TG_TABLE_SCHEMA
        ) INTO has_signals USING OLD."id";
        IF has_signals THEN
            RAISE EXCEPTION 'SupportTriageGroup % still has signals; delete them before ending it', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."primarySnapshotDigest" IS NOT NULL THEN
            RAISE EXCEPTION 'SupportTriageGroup % must drop its primary digest when it ends', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."groupCandidateKey" IS DISTINCT FROM OLD."groupCandidateKey" THEN
            RAISE EXCEPTION 'SupportTriageGroup % keeps its key as a tombstone when it ends', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        IF pg_catalog.array_position(NEW."retiredMemberIds", NULL) IS NOT NULL
            OR pg_catalog.cardinality(NEW."retiredMemberIds")
               <> (SELECT pg_catalog.count(DISTINCT member) FROM pg_catalog.unnest(NEW."retiredMemberIds") AS member) THEN
            RAISE EXCEPTION 'SupportTriageGroup retiredMemberIds must be distinct, non-null ids'
                USING ERRCODE = 'check_violation';
        END IF;
        NEW."keyRetiredAt" := now_utc;
    ELSE
        IF NEW."primarySnapshotDigest" IS DISTINCT FROM OLD."primarySnapshotDigest" THEN
            RAISE EXCEPTION 'SupportTriageGroup % primary digest changes only to NULL, with its end', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."keyRetiredAt" IS DISTINCT FROM OLD."keyRetiredAt" THEN
            RAISE EXCEPTION 'SupportTriageGroup keyRetiredAt is written by the database'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF NEW."ownerQueueState" IS DISTINCT FROM OLD."ownerQueueState" THEN
        IF NOT (OLD."ownerQueueState" = 'not_queued' AND NEW."ownerQueueState" = 'displayed'
                AND OLD."state" = 'candidate' AND NEW."state" = 'candidate') THEN
            RAISE EXCEPTION 'SupportTriageGroup % can be displayed only once, while candidate', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        NEW."displayedAt" := now_utc;
    ELSIF NEW."displayedAt" IS DISTINCT FROM OLD."displayedAt" THEN
        RAISE EXCEPTION 'SupportTriageGroup displayedAt is written by the database'
            USING ERRCODE = 'check_violation';
    END IF;

    NEW."updatedAt" := now_utc;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "SupportTriageGroup_guard"
    BEFORE INSERT OR UPDATE ON "SupportTriageGroup"
    FOR EACH ROW EXECUTE FUNCTION "support_triage_group_guard"();

CREATE OR REPLACE FUNCTION "support_triage_group_member_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    -- The message lib/accountDeletion.ts leaves on a deleted account's report.
    deleted_marker CONSTANT TEXT := '[deleted account]';
    -- limit: GROUP_MEMBER_CAP
    member_cap CONSTANT INTEGER := 50;
    report_message TEXT;
    members INTEGER;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'SupportTriageGroupMember rows are inserted and deleted, never updated'
            USING ERRCODE = 'check_violation';
    END IF;
    -- The report first, then the group: the global lock order. No membership
    -- for a deleted account's report; the row is held so a deletion waits.
    EXECUTE pg_catalog.format(
        'SELECT f."message" FROM %I."Feedback" f WHERE f."id" = $1 FOR SHARE',
        TG_TABLE_SCHEMA
    ) INTO report_message USING NEW."feedbackId";
    IF report_message = deleted_marker THEN
        RAISE EXCEPTION 'SupportTriageGroupMember cannot be created for a deleted account''s report'
            USING ERRCODE = 'check_violation';
    END IF;
    -- The group is locked by one statement and its members counted by the
    -- next, so two inserts cannot both see room for the fiftieth. One
    -- statement would not do: under READ COMMITTED a statement that waited
    -- for the lock still counts with the snapshot it took before waiting.
    EXECUTE pg_catalog.format(
        'SELECT 1 FROM %I."SupportTriageGroup" g WHERE g."id" = $1 FOR UPDATE',
        TG_TABLE_SCHEMA
    ) USING NEW."groupId";
    EXECUTE pg_catalog.format(
        'SELECT pg_catalog.count(*)::INTEGER FROM %I."SupportTriageGroupMember" m WHERE m."groupId" = $1',
        TG_TABLE_SCHEMA
    ) INTO members USING NEW."groupId";
    IF members >= member_cap THEN
        RAISE EXCEPTION 'SupportTriageGroup % already has % members', NEW."groupId", member_cap
            USING ERRCODE = 'check_violation';
    END IF;
    NEW."createdAt" := clock_timestamp() AT TIME ZONE 'UTC';
    RETURN NEW;
END;
$$;

CREATE TRIGGER "SupportTriageGroupMember_guard"
    BEFORE INSERT OR UPDATE ON "SupportTriageGroupMember"
    FOR EACH ROW EXECUTE FUNCTION "support_triage_group_member_guard"();

CREATE OR REPLACE FUNCTION "support_triage_group_signal_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    group_state TEXT;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'SupportTriageGroupSignal rows are inserted and deleted, never updated'
            USING ERRCODE = 'check_violation';
    END IF;
    -- Held FOR SHARE so the group cannot end between this check and the insert.
    EXECUTE pg_catalog.format(
        'SELECT g."state" FROM %I."SupportTriageGroup" g WHERE g."id" = $1 FOR SHARE',
        TG_TABLE_SCHEMA
    ) INTO group_state USING NEW."groupId";
    IF group_state IS NOT NULL AND group_state NOT IN ('candidate', 'confirmed') THEN
        RAISE EXCEPTION 'SupportTriageGroup % is terminal and takes no signal', NEW."groupId"
            USING ERRCODE = 'check_violation';
    END IF;
    NEW."observedAt" := clock_timestamp() AT TIME ZONE 'UTC';
    RETURN NEW;
END;
$$;

CREATE TRIGGER "SupportTriageGroupSignal_guard"
    BEFORE INSERT OR UPDATE ON "SupportTriageGroupSignal"
    FOR EACH ROW EXECUTE FUNCTION "support_triage_group_signal_guard"();

COMMIT;
