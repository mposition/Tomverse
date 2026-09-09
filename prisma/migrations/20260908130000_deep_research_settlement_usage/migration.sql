-- Gives a finalized deep research job somewhere to leave what it owes.
--
-- Issue: https://github.com/mposition/Tomverse/issues/1285
--
-- The status route finalizes the job and writes the Message in one
-- transaction, then settles the credit reservation after that transaction
-- commits. Settlement has to be outside it -- it takes the credit account
-- lock, and holding that inside the finalize transaction would serialize
-- every poll of every job behind one account -- but "after the commit" is
-- also where a process can be killed.
--
-- When that happened there was no way back. The poll that held the provider's
-- token counts had already returned; every later poll saw a terminal job and
-- took the cached early return, which never reaches settlement. The
-- reservation stayed `reserved` until `expiresAt` lapsed, and then
-- reconcileExpiredChatCreditReservations settled it as `failed` with zero
-- tokens -- a full REFUND for a job that really ran at Perplexity and really
-- cost money. The user was under-charged and the ledger never recorded the
-- cost.
--
-- This column is the durable handoff: the finalize transaction writes what
-- settlement will need, so a later poll or the maintenance sweep can complete
-- it from stored fact rather than from a poll response nobody kept.
--
-- Nullable, and every existing row keeps NULL. NULL on a terminal job means
-- "finalized before this column existed", and the sweep skips those rather
-- than inventing numbers for them: whatever happened to those reservations
-- has already happened, and a migration that guessed their token counts would
-- be writing a charge nobody measured.
ALTER TABLE "PerplexityAsyncJob" ADD COLUMN "settlementUsage" JSONB;

-- The sweep's index. It selects terminal jobs and then asks each reservation
-- whether it is still `reserved`, so `status` is the selective half and
-- `completedAt` puts the oldest unsettled debt first.
CREATE INDEX "PerplexityAsyncJob_status_completedAt_idx"
  ON "PerplexityAsyncJob"("status", "completedAt");
