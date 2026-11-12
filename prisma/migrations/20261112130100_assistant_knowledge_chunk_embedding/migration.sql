-- A semantic vector per knowledge chunk, and the label of the model that
-- produced it (docs/policy/external-conversation-import-and-memory.md
-- section 9a). Both stay NULL until an operator turns knowledge embedding on;
-- a NULL row is still found by lexical retrieval.
--
-- Stored as bytes (one int8 per dimension) and compared in the application,
-- so no extension is installed and no vector index is built. The vector is
-- derived from the chunk and is deleted with it.
--
-- Two nullable columns without a default: a catalogue change only, no table
-- rewrite, under a brief ACCESS EXCLUSIVE lock.

ALTER TABLE "AssistantKnowledgeChunk"
    ADD COLUMN "embedding" BYTEA,
    ADD COLUMN "embeddingModel" TEXT;
