-- The cards an idea left behind (owner decision 2026-11-05). An idea past its
-- plan can stop with cards nobody will run, and nothing closed them. Each row
-- is one question to the owner: close the idea's remaining cards, or keep them.
-- The Decision Maker proposes an answer through the same local typed-ask card a
-- v22 worker's question uses; only a person's confirmation, or the owner's own
-- answer in Admin, closes anything (lib/amux/ideaCardCloseService.ts).
--
-- "cards" is what was asked about: card ids, display keys, types and statuses.
-- The row holds no idea text. "localCardId" names the local card once and
-- "localCardClosedAt" records that the bridge closed it after the question left
-- "open". "handoffAt" records that a confirmed answer could not be read, so the
-- question waits for the owner's direct answer.
BEGIN;

CREATE TABLE "AmuxIdeaCardCloseQuestion" (
  "id" TEXT NOT NULL,
  "ideaId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'open',
  "reasonCode" TEXT NOT NULL,
  "cards" JSONB NOT NULL,
  "answerSource" TEXT,
  "answeredByUserId" TEXT,
  "answeredAt" TIMESTAMP(3),
  "cancelReason" TEXT,
  "handoffReason" TEXT,
  "handoffAt" TIMESTAMP(3),
  "localCardId" TEXT,
  "localCardClosedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxIdeaCardCloseQuestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AmuxIdeaCardCloseQuestion_shape_check" CHECK (
    -- The local AMUX files a question only under a lowercase UUID.
    "id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND
    "reasonCode" IN ('blocked_task', 'stale_cards') AND
    jsonb_typeof("cards") = 'array' AND jsonb_array_length("cards") >= 1 AND
    ("answerSource" IS NULL OR "answerSource" IN ('operator', 'dm_confirmed')) AND
    ("answerSource" IS DISTINCT FROM 'operator' OR "answeredByUserId" IS NOT NULL) AND
    ("answerSource" IS DISTINCT FROM 'dm_confirmed' OR "answeredByUserId" IS NULL) AND
    (("answerSource" IS NULL) = ("answeredAt" IS NULL)) AND
    ("answerSource" IS NOT NULL OR "answeredByUserId" IS NULL) AND
    ("cancelReason" IS NULL OR "cancelReason" ~ '^[a-z_]{1,64}$') AND
    (("handoffReason" IS NULL) = ("handoffAt" IS NULL)) AND
    ("handoffReason" IS NULL OR "handoffReason" ~ '^[a-z_]{1,64}$') AND
    ("localCardId" IS NULL OR "localCardId" ~ '^[A-Za-z0-9_-]{1,64}$') AND
    ("localCardClosedAt" IS NULL OR ("localCardId" IS NOT NULL AND "state" <> 'open'))
  ),
  CONSTRAINT "AmuxIdeaCardCloseQuestion_state_check" CHECK (
    ("state" = 'open' AND "answerSource" IS NULL AND "cancelReason" IS NULL) OR
    ("state" IN ('closed', 'kept') AND "answerSource" IS NOT NULL AND "cancelReason" IS NULL) OR
    ("state" = 'cancelled' AND "cancelReason" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "AmuxIdeaCardCloseQuestion_localCardId_key"
  ON "AmuxIdeaCardCloseQuestion"("localCardId");
CREATE INDEX "AmuxIdeaCardCloseQuestion_ideaId_createdAt_idx"
  ON "AmuxIdeaCardCloseQuestion"("ideaId", "createdAt");
CREATE INDEX "AmuxIdeaCardCloseQuestion_state_createdAt_idx"
  ON "AmuxIdeaCardCloseQuestion"("state", "createdAt");
CREATE INDEX "AmuxIdeaCardCloseQuestion_createdAt_idx"
  ON "AmuxIdeaCardCloseQuestion"("createdAt");
-- At most one question per idea is waiting for an answer.
CREATE UNIQUE INDEX "AmuxIdeaCardCloseQuestion_one_open_per_idea"
  ON "AmuxIdeaCardCloseQuestion"("ideaId") WHERE "state" = 'open';

ALTER TABLE "AmuxIdeaCardCloseQuestion" ADD CONSTRAINT "AmuxIdeaCardCloseQuestion_ideaId_fkey"
  FOREIGN KEY ("ideaId") REFERENCES "AmuxIdeaSubmission"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Identity never changes and a row is never deleted. State moves only forward:
-- open -> closed | kept | cancelled. The answer is written once, with that move.
-- The local card is named once and its close recorded once; a handoff is
-- recorded once, while the question is open.
CREATE FUNCTION amux_idea_card_close_question_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AMUX idea card close question is never deleted';
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id" OR
     OLD."ideaId" IS DISTINCT FROM NEW."ideaId" OR
     OLD."reasonCode" IS DISTINCT FROM NEW."reasonCode" OR
     OLD."cards" IS DISTINCT FROM NEW."cards" OR
     OLD."createdAt" IS DISTINCT FROM NEW."createdAt" OR
     (OLD."localCardId" IS NOT NULL AND
       OLD."localCardId" IS DISTINCT FROM NEW."localCardId") OR
     (OLD."localCardClosedAt" IS NOT NULL AND
       OLD."localCardClosedAt" IS DISTINCT FROM NEW."localCardClosedAt") OR
     (OLD."handoffAt" IS NOT NULL AND
       (OLD."handoffAt" IS DISTINCT FROM NEW."handoffAt" OR
        OLD."handoffReason" IS DISTINCT FROM NEW."handoffReason")) THEN
    RAISE EXCEPTION 'AMUX idea card close question identity is immutable';
  END IF;
  IF OLD."handoffAt" IS NULL AND NEW."handoffAt" IS NOT NULL AND OLD."state" <> 'open' THEN
    RAISE EXCEPTION 'AMUX idea card close question hands off only while open';
  END IF;
  IF OLD."state" = NEW."state" THEN
    IF NEW."answerSource" IS DISTINCT FROM OLD."answerSource" OR
       NEW."answeredByUserId" IS DISTINCT FROM OLD."answeredByUserId" OR
       NEW."answeredAt" IS DISTINCT FROM OLD."answeredAt" OR
       NEW."cancelReason" IS DISTINCT FROM OLD."cancelReason" THEN
      RAISE EXCEPTION 'AMUX idea card close question cannot change its % answer',
        OLD."state";
    END IF;
  ELSIF NOT (OLD."state" = 'open' AND NEW."state" IN ('closed', 'kept', 'cancelled')) THEN
    RAISE EXCEPTION 'AMUX idea card close question cannot move from % to %',
      OLD."state", NEW."state";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaCardCloseQuestion_guard"
  BEFORE UPDATE OR DELETE ON "AmuxIdeaCardCloseQuestion"
  FOR EACH ROW EXECUTE FUNCTION amux_idea_card_close_question_guard();

COMMIT;
