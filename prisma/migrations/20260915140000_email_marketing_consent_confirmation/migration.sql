-- The marketing consent confirmation step (double opt-in).
--
-- Contract: docs/policy/email-double-opt-in.md §4.1, §4.4, §11 items 1-3.
--
-- Two nullable columns and no backfill. A row switched on before this existed
-- has confirmedAt NULL and is refused by the send gate, which is the correct
-- reading of it: the switch was flipped, the mailbox owner never confirmed.
-- Writing a confirmedAt for those rows would be manufacturing the one fact
-- this column exists to record. Production had no such rows when this shipped
-- (docs/ops/q2-marketing-reach-decision.md §2.1), and the rule holds either way.
--
-- `confirmation_requested` is a consent history action of its own rather than
-- `granted`: recording "we sent a confirmation mail" as a consent is exactly
-- what the confirmation step exists to stop.

ALTER TABLE "EmailPreference" ADD COLUMN "confirmedAt" TIMESTAMP(3);
ALTER TABLE "EmailPreference" ADD COLUMN "confirmationRequestedAt" TIMESTAMP(3);

ALTER TABLE "ConsentRecord" DROP CONSTRAINT IF EXISTS "ConsentRecord_action_check";

ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_action_check"
    CHECK ("action" IN (
        'granted', 'withdrawn', 'reconfirmed', 'confirmation_notice_sent',
        'confirmation_requested', 'lapsed'
    ));
