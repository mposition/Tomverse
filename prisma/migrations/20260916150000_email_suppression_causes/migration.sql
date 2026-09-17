-- Suppression causes, written beside the entries they will replace (deploy A).
--
-- Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4
-- (v24): "A/B/C authority transfer + D cleanup". This is A, the shadow deploy.
--
-- A `SuppressionEntry` row is one per (address, scope, purposeKey), so every new
-- event overwrites the one before it and a single row cannot say both how hard
-- an address is blocked and what it takes to lift it. `SuppressionCause` keeps
-- every cause as its own append-only row. In this deploy nothing reads it:
-- sends are still decided from `SuppressionEntry` exactly as before, and the
-- entry is still written by the same merge rule. The causes are filled so that
-- a later deploy can switch the reading side over without losing history.
--
-- Three ways a cause is written, so the causes never fall behind the entries:
--   1. Backfill: every existing entry becomes one cause, checked by count.
--   2. The new build writes the cause in the same transaction as the entry,
--      marking the transaction with `SET LOCAL app.suppression_writer`.
--   3. A trigger on `SuppressionEntry` carries writes from a build that does
--      not mark its transaction -- the previous build, still serving traffic
--      while this deploy rolls out -- into causes and cause releases.

CREATE TABLE "SuppressionCause" (
    "id" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "purposeKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceEventKey" TEXT NOT NULL,
    "sourceStream" TEXT,
    "sourceDomain" TEXT,
    "sourceClassification" TEXT,
    "sourceDeliveryId" TEXT,
    "sourceMessageId" TEXT,
    "sourceRequestId" TEXT,
    "providerAccount" TEXT,
    "evidence" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releaseKind" TEXT,
    "releaseEvidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuppressionCause_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SuppressionCause_selector_reason_event_key"
    ON "SuppressionCause"("emailAddress", "scope", "purposeKey", "reason", "sourceEventKey");
CREATE INDEX "SuppressionCause_emailAddress_releasedAt_idx"
    ON "SuppressionCause"("emailAddress", "releasedAt");
CREATE INDEX "SuppressionCause_expiresAt_idx" ON "SuppressionCause"("expiresAt");

-- The scope gains `classification`, which only `marketing` may use today. The
-- names cannot collide with a purpose because the scope is part of the key.
ALTER TABLE "SuppressionCause" ADD CONSTRAINT "SuppressionCause_scope_check"
    CHECK (
        ("scope" = 'global' AND "purposeKey" = '*')
        OR ("scope" = 'classification' AND "purposeKey" IN ('marketing'))
        OR ("scope" = 'purpose' AND "purposeKey" <> '*')
    );

ALTER TABLE "SuppressionCause" ADD CONSTRAINT "SuppressionCause_reason_check"
    CHECK ("reason" IN (
        'hard_bounce', 'soft_bounce', 'complaint',
        'unsubscribe', 'manual', 'privacy_request'
    ));

ALTER TABLE "SuppressionCause" ADD CONSTRAINT "SuppressionCause_expiry_check"
    CHECK ("expiresAt" IS NULL OR "reason" = 'soft_bounce');

ALTER TABLE "SuppressionCause" ADD CONSTRAINT "SuppressionCause_source_stream_check"
    CHECK ("sourceStream" IS NULL OR "sourceStream" IN ('transactional', 'marketing'));

ALTER TABLE "SuppressionCause" ADD CONSTRAINT "SuppressionCause_provider_account_check"
    CHECK ("providerAccount" IS NULL OR "providerAccount" IN ('transactional', 'marketing'));

-- A release is recorded once, with its kind, or not at all.
ALTER TABLE "SuppressionCause" ADD CONSTRAINT "SuppressionCause_release_check"
    CHECK (
        ("releasedAt" IS NULL AND "releaseKind" IS NULL AND "releaseEvidence" IS NULL)
        OR ("releasedAt" IS NOT NULL AND "releaseKind" IS NOT NULL)
    );

-- Append-only: identity and provenance never change, and a release is written
-- once. A cause that could be edited would let history say whatever it says
-- today.
CREATE OR REPLACE FUNCTION "suppression_cause_is_append_only"()
RETURNS trigger AS $$
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."emailAddress" IS DISTINCT FROM OLD."emailAddress"
       OR NEW."scope" IS DISTINCT FROM OLD."scope"
       OR NEW."purposeKey" IS DISTINCT FROM OLD."purposeKey"
       OR NEW."reason" IS DISTINCT FROM OLD."reason"
       OR NEW."source" IS DISTINCT FROM OLD."source"
       OR NEW."sourceEventKey" IS DISTINCT FROM OLD."sourceEventKey"
       OR NEW."sourceStream" IS DISTINCT FROM OLD."sourceStream"
       OR NEW."sourceDomain" IS DISTINCT FROM OLD."sourceDomain"
       OR NEW."sourceClassification" IS DISTINCT FROM OLD."sourceClassification"
       OR NEW."sourceDeliveryId" IS DISTINCT FROM OLD."sourceDeliveryId"
       OR NEW."sourceMessageId" IS DISTINCT FROM OLD."sourceMessageId"
       OR NEW."sourceRequestId" IS DISTINCT FROM OLD."sourceRequestId"
       OR NEW."providerAccount" IS DISTINCT FROM OLD."providerAccount"
       OR NEW."evidence" IS DISTINCT FROM OLD."evidence"
       OR NEW."occurredAt" IS DISTINCT FROM OLD."occurredAt"
       OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR (OLD."releasedAt" IS NOT NULL AND (
             NEW."releasedAt" IS DISTINCT FROM OLD."releasedAt"
             OR NEW."releaseKind" IS DISTINCT FROM OLD."releaseKind"
             OR NEW."releaseEvidence" IS DISTINCT FROM OLD."releaseEvidence"
       )) THEN
        RAISE EXCEPTION
            'SuppressionCause % is append-only; only an unreleased cause may be released, once', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "suppression_cause_is_append_only"
    BEFORE UPDATE ON "SuppressionCause"
    FOR EACH ROW
    EXECUTE FUNCTION "suppression_cause_is_append_only"();

CREATE OR REPLACE FUNCTION "suppression_cause_is_not_deleted"()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'SuppressionCause % is append-only and cannot be deleted', OLD."id"
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "suppression_cause_is_not_deleted"
    BEFORE DELETE ON "SuppressionCause"
    FOR EACH ROW
    EXECUTE FUNCTION "suppression_cause_is_not_deleted"();

-- The previous build's writes, carried into causes. Skipped when the writing
-- transaction set `app.suppression_writer` -- the new build writes its own
-- cause and must not get a second one from here.
CREATE OR REPLACE FUNCTION "suppression_entry_to_cause"()
RETURNS trigger AS $$
BEGIN
    IF current_setting('app.suppression_writer', true) = 'causes' THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' THEN
        UPDATE "SuppressionCause"
           SET "releasedAt" = now(),
               "releaseKind" = 'legacy_delete',
               "releaseEvidence" = jsonb_build_object('kind', 'legacy_entry_delete', 'entryId', OLD."id")
         WHERE "emailAddress" = OLD."emailAddress"
           AND "scope" = OLD."scope"
           AND "purposeKey" = OLD."purposeKey"
           AND "releasedAt" IS NULL;
        RETURN NULL;
    END IF;

    IF TG_OP = 'UPDATE'
       AND NEW."reason" IS NOT DISTINCT FROM OLD."reason"
       AND NEW."source" IS NOT DISTINCT FROM OLD."source"
       AND NEW."expiresAt" IS NOT DISTINCT FROM OLD."expiresAt"
       AND NEW."occurredAt" IS NOT DISTINCT FROM OLD."occurredAt"
       AND NEW."sourceStream" IS NOT DISTINCT FROM OLD."sourceStream"
       AND NEW."sourceDomain" IS NOT DISTINCT FROM OLD."sourceDomain"
       AND NEW."sourceClassification" IS NOT DISTINCT FROM OLD."sourceClassification"
       AND NEW."sourceDeliveryId" IS NOT DISTINCT FROM OLD."sourceDeliveryId"
       AND NEW."sourceMessageId" IS NOT DISTINCT FROM OLD."sourceMessageId"
       AND NEW."evidence" IS NOT DISTINCT FROM OLD."evidence" THEN
        RETURN NULL;
    END IF;

    INSERT INTO "SuppressionCause" (
        "id", "emailAddress", "scope", "purposeKey", "reason", "source",
        "sourceEventKey", "sourceStream", "sourceDomain", "sourceClassification",
        "sourceDeliveryId", "sourceMessageId", "providerAccount", "evidence",
        "occurredAt", "expiresAt"
    ) VALUES (
        gen_random_uuid()::text, NEW."emailAddress", NEW."scope", NEW."purposeKey",
        NEW."reason", NEW."source",
        'legacy-trigger:' || NEW."id" || ':' || gen_random_uuid()::text,
        NEW."sourceStream", NEW."sourceDomain", NEW."sourceClassification",
        NEW."sourceDeliveryId", NEW."sourceMessageId", NEW."sourceStream",
        NEW."evidence", NEW."occurredAt", NEW."expiresAt"
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Backfill and trigger installation in one statement: an entry written between
-- the two would otherwise be neither backfilled nor carried.
DO $$
DECLARE
    entry_count BIGINT;
    cause_count BIGINT;
BEGIN
    LOCK TABLE "SuppressionEntry" IN SHARE ROW EXCLUSIVE MODE;

    INSERT INTO "SuppressionCause" (
        "id", "emailAddress", "scope", "purposeKey", "reason", "source",
        "sourceEventKey", "sourceStream", "sourceDomain", "sourceClassification",
        "sourceDeliveryId", "sourceMessageId", "providerAccount", "evidence",
        "occurredAt", "expiresAt", "createdAt"
    )
    SELECT
        gen_random_uuid()::text, e."emailAddress", e."scope", e."purposeKey",
        e."reason", e."source",
        'legacy:suppression:' || e."id",
        e."sourceStream", e."sourceDomain", e."sourceClassification",
        e."sourceDeliveryId", e."sourceMessageId", e."sourceStream", e."evidence",
        e."occurredAt", e."expiresAt", e."createdAt"
    FROM "SuppressionEntry" AS e;

    SELECT count(*) INTO entry_count FROM "SuppressionEntry";
    SELECT count(*) INTO cause_count FROM "SuppressionCause"
     WHERE "sourceEventKey" LIKE 'legacy:suppression:%';
    IF entry_count <> cause_count THEN
        RAISE EXCEPTION 'SuppressionCause backfill wrote % causes for % entries', cause_count, entry_count;
    END IF;

    CREATE TRIGGER "suppression_entry_to_cause"
        AFTER INSERT OR UPDATE OR DELETE ON "SuppressionEntry"
        FOR EACH ROW
        EXECUTE FUNCTION "suppression_entry_to_cause"();
END;
$$;

-- Every change to a preference's enabled state, append-only. A withdrawal that
-- records no consent -- `service_status` needs none -- still needs a stable id
-- for the suppression cause it creates.
CREATE TABLE "EmailPreferenceTransition" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "fromEnabled" BOOLEAN NOT NULL,
    "toEnabled" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "consentRecordId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailPreferenceTransition_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailPreferenceTransition_userId_purpose_occurredAt_idx"
    ON "EmailPreferenceTransition"("userId", "purpose", "occurredAt");

ALTER TABLE "EmailPreferenceTransition"
    ADD CONSTRAINT "EmailPreferenceTransition_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmailPreferenceTransition" ADD CONSTRAINT "EmailPreferenceTransition_source_check"
    CHECK ("source" IN (
        'signup', 'preference_center', 'unsubscribe_link', 'admin', 'system_default',
        'consent_confirmation', 'privacy_request', 'provider_complaint'
    ));

ALTER TABLE "EmailPreferenceTransition" ADD CONSTRAINT "EmailPreferenceTransition_change_check"
    CHECK ("fromEnabled" <> "toEnabled");

-- Which provider account a message went out through, and as whom. Fixed at
-- send, so a webhook binds to the delivery of its own account and a cause's
-- domain is the one actually used, not whatever the configuration says later.
ALTER TABLE "EmailDelivery"
    ADD COLUMN "providerAccount" TEXT,
    ADD COLUMN "sentFrom" TEXT,
    ADD COLUMN "sentDomain" TEXT;

ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_provider_account_check"
    CHECK ("providerAccount" IS NULL OR "providerAccount" IN ('transactional', 'marketing'));

-- Existing sends: the account follows the stream of the version they were sent
-- under. Every send before the marketing account existed was transactional.
UPDATE "EmailDelivery" AS d
   SET "providerAccount" = CASE WHEN v."classification" = 'marketing' THEN 'marketing' ELSE 'transactional' END
  FROM "TemplateVersion" AS v
 WHERE d."templateVersionId" = v."id"
   AND d."sentAt" IS NOT NULL;

CREATE INDEX "EmailDelivery_providerAccount_providerMessageId_idx"
    ON "EmailDelivery"("providerAccount", "providerMessageId");
