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

-- No index. The list already reads a user's conversations by `userId` and
-- orders them by `updatedAt`; nothing filters or sorts on `pinnedAt`, so an
-- index on it would buy no plan and cost every write -- and creating it
-- non-concurrently would take a write lock on a production table for the
-- length of the build. The day a query needs one, it comes with that query and
-- with `CONCURRENTLY`.
