-- A refund decision claims `processing` before it touches Stripe, and leaves it
-- only once the local side has committed.
--
-- Without it, a crash between `stripe.refunds.create` and the local commit left
-- the request in `pending`: the money had gone out, nothing recorded it, and
-- the next attempt issued a second refund. The claim is also what stops two
-- administrators approving at the same moment, since only one can move the row
-- out of `pending`.
ALTER TABLE "RefundRequest"
  ADD COLUMN "processingStartedAt" TIMESTAMP(3);

-- Reconciliation reads exactly this: rows stuck in `processing` since before a
-- cutoff.
CREATE INDEX "RefundRequest_status_processingStartedAt_idx"
  ON "RefundRequest"("status", "processingStartedAt");
