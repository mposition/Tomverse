-- Owner decision 2026-11-15: an answer to a v22 worker's question goes whole
-- to the resumed run (in the local CLI flow, as the owner-answer.md context
-- file), so its one bound is the code's AMUX_V22_OWNER_ANSWER_MAX_BYTES
-- (512 KiB: the Decision Maker's or an operator's longest answer, 256 KiB,
-- with the line that names who gave it; lib/amux/v22OwnerQuestionCore.ts).
-- This CHECK still held the 8,000 characters of 2026-10-30, under the 30 KiB
-- the code had already allowed. Only the answerText bound changes; the rest of
-- the CHECK is as it was. Rollback: drop and add the constraint again with
-- 8000 (only after no answer over it remains).
ALTER TABLE "AmuxV22TaskQuestion"
  DROP CONSTRAINT "AmuxV22TaskQuestion_shape_check",
  ADD CONSTRAINT "AmuxV22TaskQuestion_shape_check" CHECK (
    "sequence" >= 1 AND "questionSha256" ~ '^[0-9a-f]{64}$' AND
    "worker" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' AND
    ("answerText" IS NULL OR char_length("answerText") BETWEEN 1 AND 524288) AND
    ("answerSource" IS NULL OR "answerSource" IN ('operator', 'dm_confirmed', 'dm')) AND
    ("localCardId" IS NULL OR "localCardId" ~ '^[A-Za-z0-9_-]{1,64}$') AND
    ("localCardClosedAt" IS NULL OR ("localCardId" IS NOT NULL AND "state" <> 'open'))
  );
