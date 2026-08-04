-- Release B slice B5b (policy §7, §7.1): an imported conversation can be
-- locked behind a password, exactly like a native one.
--
-- The column mirrors `Conversation.password`: a scrypt hash written by
-- lib/conversationLock.ts, NULL when the resource is not locked. Reusing the
-- same hash format is deliberate — one password implementation, one verifier,
-- one attempt-limit path.
ALTER TABLE "ExternalConversation" ADD COLUMN "password" TEXT;

-- §7.1: a memory suspended because its only evidence is locked. Distinct from
-- `suspended_by_source_delete`: the source still exists and the memory comes
-- back on unlock, whereas a deleted source needs the user to re-ground it.
-- The status allowlist already contains both values (Release B slice B1), so
-- this is an index rather than a constraint change: the sweep and the restore
-- both need to find suspended memories for one account cheaply.
CREATE INDEX IF NOT EXISTS "MemoryItem_userId_suspendedReason_idx"
    ON "MemoryItem" ("userId", "suspendedReason");
