-- Conversation tools (owner direction 2026-11-28): archiving a conversation, and
-- prompts an account saves under a name.
--
--   Conversation.archivedAt  new, nullable, no default, no backfill, no index.
--                            NULL is "not archived", which is every existing
--                            row. Adding a nullable column without a default is
--                            a catalogue change in PostgreSQL 11+: it takes the
--                            table's ACCESS EXCLUSIVE lock only for that change
--                            and rewrites no row. No index, because every read
--                            is one account's rows (the userId-led indexes
--                            already serve it) and this is a residual filter
--                            over them; an index here would be a CREATE INDEX
--                            on the largest table for no plan change.
--                            Written with raw SQL (lib/conversationArchive.ts)
--                            so archiving does not move "updatedAt".
--   SavedPrompt              new table. One row per prompt: owner, title, body,
--                            ordering value, timestamps. Cascades from User,
--                            so deleting the account deletes it. The bounds
--                            CHECK repeats SAVED_PROMPT_LIMITS
--                            (lib/savedPromptsCore.ts); the per-account count
--                            is enforced by the route under an advisory lock.
--
-- Rollback (nothing else reads either):
--   DROP TABLE "SavedPrompt";
--   ALTER TABLE "Conversation" DROP COLUMN "archivedAt";
ALTER TABLE "Conversation" ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE TABLE "SavedPrompt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedPrompt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SavedPrompt_bounds_check" CHECK (
        char_length("title") BETWEEN 1 AND 80
        AND char_length("body") BETWEEN 1 AND 10000
        AND "sortOrder" >= 0
    )
);

CREATE INDEX "SavedPrompt_userId_sortOrder_idx" ON "SavedPrompt"("userId", "sortOrder");

ALTER TABLE "SavedPrompt" ADD CONSTRAINT "SavedPrompt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
