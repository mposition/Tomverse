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

-- The sequence of the last accepted pin write, which is how the server orders
-- writes a client cannot. A request whose connection dropped may still be
-- applied afterwards; each write carries the sequence of the tap that made it
-- and applies only when greater, so the last tap is the last write in whatever
-- order the requests arrive -- including two that both failed on the wire,
-- which a compare-and-set on an observed version could not order.
--
-- DOUBLE PRECISION rather than BIGINT: it holds every integer up to 2^53
-- exactly (a millisecond timestamp is about 1.8e12), and a BIGINT on this table
-- would make JSON serialisation throw wherever a whole conversation row is read.
--
-- NOT NULL with a constant default. Unlike a column whose NULL would mean "a
-- writer forgot", 0 is a true value here -- no pin write has ever been accepted
-- -- and it is true of every existing row. On PostgreSQL 11 and later a
-- constant default lives in the catalogue rather than in each row, so this
-- does not rewrite the table; it still takes a brief ACCESS EXCLUSIVE lock to
-- change the catalogue.
ALTER TABLE "Conversation" ADD COLUMN "pinSeq" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- No index on either. The list already reads a user's conversations by
-- `userId` and orders them by `updatedAt`; nothing filters or sorts on these,
-- and the write addresses one row by primary key. An index would buy no plan
-- and cost every write -- and creating it non-concurrently would take a write
-- lock on a production table for the length of the build. The day a query
-- needs one, it comes with that query and with `CONCURRENTLY`.
