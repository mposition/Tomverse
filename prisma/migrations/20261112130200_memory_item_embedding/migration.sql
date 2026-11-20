-- A semantic vector per memory statement, and the label of the model that
-- produced it (docs/policy/external-conversation-import-and-memory.md
-- section 9a). Both stay NULL until an operator turns duplicate detection on.
--
-- Stored as bytes (one int8 per dimension) and compared in the application.
-- The vector is derived from the statement: it is cleared when the statement
-- is edited and deleted with the row.
--
-- Two nullable columns without a default: a catalogue change only, no table
-- rewrite, under a brief ACCESS EXCLUSIVE lock.

ALTER TABLE "MemoryItem"
    ADD COLUMN "embedding" BYTEA,
    ADD COLUMN "embeddingModel" TEXT;
