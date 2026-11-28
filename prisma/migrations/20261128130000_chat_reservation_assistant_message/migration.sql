-- Owner direction 2026-11-28: a Chat answer shows the credits it actually
-- cost. The reservation is the record of what a turn was charged, and nothing
-- on it said which answer it paid for: traceId, the ledger's reservationId and
-- reservationPayload carry no message id, and matching on time and model goes
-- wrong between two conversations running at once.
--
-- Additive and nullable with no default and no backfill. Every existing row
-- keeps NULL, which the reader takes as "no figure to show" -- an answer from
-- before this column simply shows nothing. No reservation, settlement or
-- refund reads the column, so no amount or status transition depends on it.
--
-- A plain value, not a foreign key, the same choice RoutingRun made for its
-- assistantMessageId: deleting a conversation cascades its messages, and that
-- must neither be held up by nor cascade into the financial record. A
-- conversation delete therefore leaves an opaque id that no longer resolves;
-- account deletion clears it with the reservation's other identifiers
-- (lib/accountDataAnonymisation.ts).
--
-- Rollback: DROP INDEX "ChatCreditReservation_assistantMessageId_idx";
-- ALTER TABLE "ChatCreditReservation" DROP COLUMN "assistantMessageId";
-- (nothing else references it).
ALTER TABLE "ChatCreditReservation" ADD COLUMN "assistantMessageId" TEXT;

-- The read is "the reservations of these answers", at most one page of a
-- conversation at a time. Without an index it walks every reservation the
-- account ever made through ("userId", "createdAt").
--
-- Not CONCURRENTLY: Postgres refuses it inside the transaction Prisma runs a
-- migration in. The build takes a SHARE lock, so reservation inserts and
-- settlements wait while it runs -- the same trade
-- 20261012040000_guest_chat_auto_credit_phase made on this table for its own
-- index. The table holds one row per paid turn; at today's size the build is
-- short. Should it ever not be, this index moves to its own CONCURRENTLY
-- statement outside a migration transaction.
CREATE INDEX "ChatCreditReservation_assistantMessageId_idx"
    ON "ChatCreditReservation"("assistantMessageId");
