-- Scheduled-task result notices (lib/scheduledTaskNotice.ts,
-- docs/policy/email-notifications.md §3.2, "4a").
--
--   ScheduledTask.emailOnFinish      the per-task "email me when it finishes"
--                                    switch. Default true: the notice is
--                                    service mail about the account's own task,
--                                    which needs no consent and starts on like
--                                    service_status (lib/emailPreferenceCore.ts).
--   ScheduledTaskRun.noticeQueuedAt  the once-per-run marker. It is set only
--                                    while NULL, in the same transaction that
--                                    writes the outbox rows, so a retried or
--                                    duplicated finish cannot queue a second
--                                    notice for the same run.
--
-- The new email purpose `scheduled_tasks` (classification `service`) joins the
-- five CHECKs that list purposes. Every one is widened and none narrowed, so
-- every existing row still passes; each DROP is paired with its ADD in one
-- ALTER TABLE.
--
-- Nothing is queued until SCHEDULED_TASK_EMAIL_ENABLED is exactly "true"
-- (default off).
--
-- Rollback (only while no row carries the purpose `scheduled_tasks`):
--   ALTER TABLE "ScheduledTaskRun" DROP COLUMN "noticeQueuedAt";
--   ALTER TABLE "ScheduledTask" DROP COLUMN "emailOnFinish";
--   and re-add the five CHECKs below without 'scheduled_tasks'.
BEGIN;

ALTER TABLE "ScheduledTask" ADD COLUMN "emailOnFinish" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "ScheduledTaskRun" ADD COLUMN "noticeQueuedAt" TIMESTAMPTZ(3);

ALTER TABLE "EmailPreference"
    DROP CONSTRAINT "EmailPreference_purpose_check",
    ADD CONSTRAINT "EmailPreference_purpose_check"
    CHECK ("purpose" IN (
        'security', 'billing', 'service_status', 'scheduled_tasks',
        'product_updates', 'newsletter', 'promotions'
    ));

ALTER TABLE "EmailPermissionEvent"
    DROP CONSTRAINT "EmailPermissionEvent_scopeKey_check",
    ADD CONSTRAINT "EmailPermissionEvent_scopeKey_check"
    CHECK ("scopeKey" IN (
        '*',
        'transactional', 'service', 'marketing',
        'security', 'billing', 'service_status', 'scheduled_tasks',
        'product_updates', 'newsletter', 'promotions'
    ));

ALTER TABLE "EmailSendApproval"
    DROP CONSTRAINT "EmailSendApproval_purposeKey_check",
    ADD CONSTRAINT "EmailSendApproval_purposeKey_check"
    CHECK ("purposeKey" IS NULL OR "purposeKey" IN (
        '*', 'security', 'billing', 'service_status', 'scheduled_tasks',
        'product_updates', 'newsletter', 'promotions'
    ));

ALTER TABLE "EmailPermissionDecision"
    DROP CONSTRAINT "EmailPermissionDecision_purpose_check",
    ADD CONSTRAINT "EmailPermissionDecision_purpose_check"
    CHECK ("purpose" IN ('security', 'billing', 'service_status', 'scheduled_tasks', 'product_updates', 'newsletter', 'promotions'));

-- The pairs are lib/emailPreferenceCore.ts's EMAIL_PURPOSE_CLASSIFICATION, and
-- tests/emailPurposeClassification.test.mjs reads the newest definition here.
ALTER TABLE "EmailPermissionDecision"
    DROP CONSTRAINT "EmailPermissionDecision_purpose_classification_check",
    ADD CONSTRAINT "EmailPermissionDecision_purpose_classification_check"
    CHECK (
        ("classification" = 'transactional' AND "purpose" IN ('security', 'billing'))
        OR ("classification" = 'service' AND "purpose" IN ('service_status', 'scheduled_tasks'))
        OR ("classification" = 'marketing' AND "purpose" IN ('product_updates', 'newsletter', 'promotions'))
    );

COMMIT;
