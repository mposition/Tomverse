-- The send metadata moves onto the version it was published under.
--
-- Contract: docs/policy/email-notifications.md §10.2, and the redesign draft's
-- template metadata decision (docs/policy/email-product-news-redesign-draft.md,
-- section 7.2).
--
-- Until now `classification`, `purpose` and `requiresUnsubscribe` lived only on
-- `EmailTemplate`, and `ensureTemplateVersion()` upserted that row with
-- `update: {}`. A template reclassified in code kept its old row, and the drain
-- read the classification from code and the unsubscribe flag from the row -- so
-- a template moved to `marketing` would have been sent without an unsubscribe
-- link.
--
-- The three values now belong to each `TemplateVersion` and never change after
-- the row is written. A change in code produces a new version even when the
-- copy is byte-identical, and the drain refuses a version whose values differ
-- from the definition it is sending under.
--
-- Backfill: every existing version takes the value its `EmailTemplate` row
-- holds. That row was written once, when the template was first registered,
-- and never updated, so it is the value in force when those versions were
-- published. Copying the *current code* instead would rewrite history; where
-- code and row disagree, `npm run report:email-template-metadata` lists it and
-- nothing here corrects it.

ALTER TABLE "TemplateVersion"
    ADD COLUMN "classification" TEXT,
    ADD COLUMN "purpose" TEXT,
    ADD COLUMN "requiresUnsubscribe" BOOLEAN;

UPDATE "TemplateVersion" AS tv
   SET "classification" = t."classification",
       "purpose" = t."purpose",
       "requiresUnsubscribe" = t."requiresUnsubscribe"
  FROM "EmailTemplate" AS t
 WHERE tv."templateId" = t."id";

ALTER TABLE "TemplateVersion"
    ALTER COLUMN "classification" SET NOT NULL,
    ALTER COLUMN "requiresUnsubscribe" SET NOT NULL;

-- The same two rules `EmailTemplate` holds, for the same reasons.
ALTER TABLE "TemplateVersion" ADD CONSTRAINT "TemplateVersion_unsubscribe_check"
    CHECK (
        ("classification" = 'marketing' AND "requiresUnsubscribe")
        OR ("classification" IN ('transactional', 'legal') AND NOT "requiresUnsubscribe")
        OR "classification" = 'service'
    );

ALTER TABLE "TemplateVersion" ADD CONSTRAINT "TemplateVersion_purpose_check"
    CHECK (
        ("classification" IN ('marketing', 'service') AND "purpose" IS NOT NULL)
        OR ("classification" IN ('transactional', 'legal') AND "purpose" IS NULL)
    );

-- Written once. A version that could be reclassified in place would answer
-- "what did we send under" with whatever it says today.
CREATE OR REPLACE FUNCTION "template_version_send_metadata_is_immutable"()
RETURNS trigger AS $$
BEGIN
    IF NEW."classification" IS DISTINCT FROM OLD."classification"
       OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
       OR NEW."requiresUnsubscribe" IS DISTINCT FROM OLD."requiresUnsubscribe" THEN
        RAISE EXCEPTION
            'TemplateVersion % send metadata is immutable; publish a new version instead', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "template_version_send_metadata_is_immutable"
    BEFORE UPDATE ON "TemplateVersion"
    FOR EACH ROW
    EXECUTE FUNCTION "template_version_send_metadata_is_immutable"();

CREATE INDEX "TemplateVersion_classification_idx" ON "TemplateVersion"("classification");
