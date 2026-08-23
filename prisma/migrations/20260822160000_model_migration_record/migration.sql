-- What an approved retirement reconciliation changed, per user and per field.
--
-- .github/audits/model-lifecycle-email-2026-08-22.md §12, ML-11.
--
-- scripts/run-default-model-reconciliation.mjs reported counts to stdout and
-- kept nothing, so afterwards there was no way to say which accounts had been
-- touched. A "we changed your default model" notice then has two possible
-- audiences -- everybody, or nobody -- and both are wrong in a way that cannot
-- be taken back once the mail has gone.
--
-- Append-only, and registered as retained: an entry removed from the middle
-- makes a past change unanswerable, which is the state this ends.
--
-- Additive: one new table, nothing existing read or written.

CREATE TABLE "ModelMigrationRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "workItemId" TEXT,
    "field" TEXT NOT NULL,
    "fromModelId" TEXT NOT NULL,
    "toModelId" TEXT NOT NULL,
    "ticket" TEXT NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelMigrationRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ModelMigrationRecord_userId_changedAt_idx"
    ON "ModelMigrationRecord"("userId", "changedAt");

CREATE INDEX "ModelMigrationRecord_fromModelId_toModelId_changedAt_idx"
    ON "ModelMigrationRecord"("fromModelId", "toModelId", "changedAt");

CREATE INDEX "ModelMigrationRecord_workItemId_idx"
    ON "ModelMigrationRecord"("workItemId");

-- Cascades with the account. The row exists to address a notice to this person
-- and to answer what their setting held before; both die with the account, so
-- keeping it would be keeping a user id for no purpose.
ALTER TABLE "ModelMigrationRecord"
    ADD CONSTRAINT "ModelMigrationRecord_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The four places a stored model id lives. Named rather than free text because
-- the completion notice says which of them moved, and a field it cannot
-- recognise would be a change the user is never told about.
ALTER TABLE "ModelMigrationRecord" ADD CONSTRAINT "ModelMigrationRecord_field_check"
    CHECK ("field" IN (
        'user_settings_default_model',
        'new_conversation_model_ids',
        'conversation_selected_models',
        'app_setting_guest_default'
    ));

-- A record of a change that changed nothing would inflate the audience of a
-- notice that tells people their settings moved.
ALTER TABLE "ModelMigrationRecord" ADD CONSTRAINT "ModelMigrationRecord_moved_check"
    CHECK ("fromModelId" <> "toModelId");

-- The approval the run carried. The script already refuses to write without a
-- ticket and an actor; storing them is what makes a row traceable back to the
-- decision months later.
ALTER TABLE "ModelMigrationRecord" ADD CONSTRAINT "ModelMigrationRecord_approval_check"
    CHECK (length("ticket") > 0 AND length("actorEmail") > 0);

-- The guest default is an AppSetting, not a person's row, so it carries no
-- user. Everything else does.
ALTER TABLE "ModelMigrationRecord" ADD CONSTRAINT "ModelMigrationRecord_conversation_field_check"
    CHECK ("conversationId" IS NULL OR "field" = 'conversation_selected_models');
