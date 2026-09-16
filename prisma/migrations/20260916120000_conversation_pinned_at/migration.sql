-- A pin belongs to the account, not to one browser.
--
-- Pinning lived in `localStorage`, so the same account opened on a second
-- device lost the order it had arranged. Nobody reports that: the list does not
-- look broken, it looks ordinary, which is exactly why it survived this long.
--
-- Additive and nullable with no default: NULL is "not pinned", every existing
-- row is already correct, and there is no backfill and no follow-up NOT NULL
-- migration to owe. Existing local pins are read alongside this column by the
-- sidebar and settle here the next time somebody toggles that conversation, so
-- nothing is written on a page load nobody asked to change anything on.
ALTER TABLE "Conversation" ADD COLUMN "pinnedAt" TIMESTAMP(3);

-- The sidebar asks "which of this account's conversations are pinned" on every
-- list read.
CREATE INDEX "Conversation_userId_pinnedAt_idx" ON "Conversation"("userId", "pinnedAt");
