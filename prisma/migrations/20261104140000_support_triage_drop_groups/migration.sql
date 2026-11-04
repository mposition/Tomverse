-- Drops the support-triage group and decision-record tables and the trigger
-- functions only they used (docs/policy/support-triage.md §5, §6).
--
-- Nothing writes them: the model names duplicates itself since the owner's
-- 2026-10-19 decision, and group formation and the person-decision path stopped
-- with it. From this release nothing reads them either.
--
-- This migration deletes no row. Deleting user data needs the owner's approval,
-- so it refuses while any of the five tables holds one. The tables are locked
-- before the check, so nothing can arrive between the check and the drop. A
-- refusal rolls everything back and leaves Prisma's row for this migration
-- failed; once the owner has decided about the rows,
-- `prisma migrate resolve --rolled-back` lets the next deploy try again.
--
-- No baseline-check header: `prisma migrate diff` sees a dropped table.
--
-- No BEGIN or COMMIT, deliberately. Prisma sends this file as one batch, which
-- PostgreSQL runs as one transaction. An explicit BEGIN would leave the
-- connection in an aborted transaction after a refusal, and Prisma then reports
-- "current transaction is aborted" instead of the reason below.

-- Dropping the two tables with a foreign key to "Feedback" also takes ACCESS
-- EXCLUSIVE on "Feedback" for that moment. The wait is bounded rather than left
-- to queue every reader of a report behind it.
SET LOCAL lock_timeout = '5s';

LOCK TABLE
    "SupportTriageGroup",
    "SupportTriageGroupMember",
    "SupportTriageGroupSignal",
    "SupportTriageDecisionRecord",
    "SupportTriageDecisionRecordLink"
    IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "SupportTriageGroup")
        OR EXISTS (SELECT 1 FROM "SupportTriageGroupMember")
        OR EXISTS (SELECT 1 FROM "SupportTriageGroupSignal")
        OR EXISTS (SELECT 1 FROM "SupportTriageDecisionRecord")
        OR EXISTS (SELECT 1 FROM "SupportTriageDecisionRecordLink") THEN
        RAISE EXCEPTION 'support-triage group or decision-record tables still hold rows; nothing was dropped'
            USING ERRCODE = 'restrict_violation',
                  HINT = 'Deleting user data needs the owner''s approval. See the header of this migration.';
    END IF;
END;
$$;

DROP TABLE "SupportTriageGroupMember";
DROP TABLE "SupportTriageGroupSignal";
DROP TABLE "SupportTriageGroup";
DROP TABLE "SupportTriageDecisionRecordLink";
DROP TABLE "SupportTriageDecisionRecord";

-- Their triggers went with the tables; left behind, these would read as live.
DROP FUNCTION "support_triage_group_guard"();
DROP FUNCTION "support_triage_group_member_guard"();
DROP FUNCTION "support_triage_group_signal_guard"();
DROP FUNCTION "support_triage_decision_record_guard"();
DROP FUNCTION "support_triage_decision_record_has_link"();
DROP FUNCTION "support_triage_decision_record_link_guard"();
DROP FUNCTION "support_triage_decision_record_link_gone"();
