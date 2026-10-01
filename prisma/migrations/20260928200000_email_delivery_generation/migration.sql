-- A delivery that was skipped because its display contract moved, and the one
-- that replaces it.
--
-- Contract: docs/policy/email-product-news-redesign-draft.md section 7.6 (C16,
-- C33).
--
-- Nothing here sends anything, and no row is written by this migration. Every
-- existing delivery becomes generation 0 with no predecessor, which is what it
-- is.
--
-- ## Why a generation at all
--
-- A message is rendered at enqueue and authorised again just before it is handed
-- to the provider. C16 is the gap: the display obligations can change while the
-- message sits in the queue, so the footer it was rendered with may no longer be
-- the footer the law requires. Section 7.6's answer is to skip that delivery and
-- enqueue a replacement rendered under the current contract, both in one
-- transaction.
--
-- Which the current unique index forbids. `(eventId, recipientKey)` says one
-- message per recipient per event, and a replacement is a second one. So the
-- generation joins the key: the same recipient may have one row per generation
-- and no more, and a writer that does not know about generations still collides
-- on generation 0 exactly as before. That is why the index is widened rather
-- than dropped.
--
-- ## The two invariants the database holds
--
-- A root is generation 0 and supersedes nothing; a replacement is generation n
-- and supersedes exactly one row. Both directions, as one biconditional, because
-- either half alone permits the state that cannot be read: a generation-2 row
-- with no predecessor is a replacement for a message nobody can find, and a
-- generation-0 row that supersedes something is a replacement claiming to be the
-- original.
--
-- And `supersedesDeliveryId` is unique, which is section 7.6's own words: one
-- delivery has at most one replacement. Without it a crash between the skip and
-- the insert could produce two messages for one skip, which is the duplicate the
-- idempotency key exists to prevent -- and that key is derived from the root and
-- the generation, so two replacements of the same row at the same generation
-- would carry the same key and the provider would drop one silently.
--
-- `rootDeliveryId` is stored rather than walked. The idempotency key section 7.6
-- fixes is `rootDeliveryId:g<generation>:<hash prefix>`, and a key that needed a
-- recursive query to compute would be a key the drain could fail to compute.
-- A root's own id, filled by the trigger below when the writer leaves it null,
-- because a root cannot name an id that does not exist until it is inserted.
--
-- ON DELETE SET NULL on the self reference, for the reason the permission
-- decision gives about its own delivery: a delivery is purged on its own
-- retention schedule, and losing the message must not take the chain with it.
-- The verdicts are what outlive both, and they are joined by the same column.
--
-- One transaction: a widened unique index and the column it names are one change.

BEGIN;

ALTER TABLE "EmailDelivery"
    ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "supersedesDeliveryId" TEXT,
    ADD COLUMN "rootDeliveryId" TEXT;

-- Every existing row is its own root. Written here rather than left to the
-- trigger, which only fires on insert.
UPDATE "EmailDelivery" SET "rootDeliveryId" = "id" WHERE "rootDeliveryId" IS NULL;

CREATE OR REPLACE FUNCTION "email_delivery_root"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    -- Empty as well as NULL. The column is NOT NULL and the Prisma model gives
    -- it an empty-string default, because Prisma cannot express "the database
    -- fills this from the row own id" and a writer inserting a root cannot name
    -- an id that does not exist yet. So the empty string is what "absent" looks
    -- like on the way in, and this is the one place that knows it.
    IF NEW."rootDeliveryId" IS NULL OR NEW."rootDeliveryId" = pg_catalog.text('') THEN
        NEW."rootDeliveryId" := NEW."id";
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "email_delivery_root"
    BEFORE INSERT ON "EmailDelivery"
    FOR EACH ROW EXECUTE FUNCTION "email_delivery_root"();

ALTER TABLE "EmailDelivery" ALTER COLUMN "rootDeliveryId" SET NOT NULL;

-- The empty string is the "fill me" value the trigger above recognises, and it is
-- the default schema.prisma declares, so the generated client may omit the column
-- on insert. Without it here the migrated schema and schema.prisma disagree and
-- every DB integration suite stops at the drift check before running anything.
ALTER TABLE "EmailDelivery" ALTER COLUMN "rootDeliveryId" SET DEFAULT '';

ALTER TABLE "EmailDelivery"
    ADD CONSTRAINT "EmailDelivery_supersedes_fkey"
    FOREIGN KEY ("supersedesDeliveryId") REFERENCES "EmailDelivery"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EmailDelivery"
    ADD CONSTRAINT "EmailDelivery_root_fkey"
    FOREIGN KEY ("rootDeliveryId") REFERENCES "EmailDelivery"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "EmailDelivery_supersedesDeliveryId_key"
    ON "EmailDelivery"("supersedesDeliveryId");

CREATE INDEX "EmailDelivery_rootDeliveryId_idx"
    ON "EmailDelivery"("rootDeliveryId");

ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_generation_check"
    CHECK ("generation" >= 0);

-- A root is generation 0 and supersedes nothing; a replacement is a later
-- generation and supersedes exactly one row.
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_generation_root_check"
    CHECK (("supersedesDeliveryId" IS NULL) = ("generation" = 0));

-- Nothing supersedes itself, and nothing is its own predecessor's root by
-- accident: a row whose generation is 0 is its own root, and a later generation
-- names another row's.
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_supersedes_self_check"
    CHECK ("supersedesDeliveryId" IS DISTINCT FROM "id");

ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_root_generation_check"
    CHECK (("generation" = 0) = ("rootDeliveryId" = "id"));

-- The widened key. Dropped and recreated rather than altered: the old one is
-- implied by the new one for every existing row, all of which are generation 0.
DROP INDEX "EmailDelivery_eventId_recipientKey_key";

CREATE UNIQUE INDEX "EmailDelivery_eventId_recipientKey_generation_key"
    ON "EmailDelivery"("eventId", "recipientKey", "generation");

COMMIT;
