-- §22: per-answer memory attribution, which the day counters cannot give.
--
-- The injection ratio is already counted as it happens. What no counter can
-- produce is which *answer* carried memory, and §22's follow-up proxy needs
-- exactly that to compare the answers memory shaped against the ones it did
-- not. §8.1 invariant 4 permits the used count and non-sensitive aggregate
-- metadata on a message; the memory text is never written here.
--
-- Both columns are nullable, so this is a catalogue-only change on an existing
-- table: NULL is the correct reading for every answer written before it, which
-- is "no context bundle accompanied this request".
ALTER TABLE "Message" ADD COLUMN "memoryUsedCount" INTEGER;
ALTER TABLE "Message" ADD COLUMN "memoryTokens" INTEGER;

-- The proxy's window is "answers in the last N days", across all
-- conversations. The only existing index is on conversationId, so without this
-- the admin report sequentially scans the largest table in the database.
CREATE INDEX "Message_createdAt_idx" ON "Message" ("createdAt");
