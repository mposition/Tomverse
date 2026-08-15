-- A purchased-credit lot can never hold less than nothing.
--
-- Contract: docs/policy/credit-and-cost-limits.md §9.
--
-- `reserveAddOnCredits()` decides sufficiency from a read of the account's
-- lots and then decrements them. The decrement is atomic per row; the
-- decision is not. Until #463 the memory-extraction path made that decision
-- without holding `credit-account:<userId>`, so a run created while a chat
-- turn was reserving could read the same balance, both pass, and leave
-- `remainingCredits` negative -- an account holding credits it never bought.
--
-- #463 restored the lock, which is what actually serialises the decision.
-- This is the net underneath it: the invariant stops depending on every
-- future caller remembering. A CHECK cannot serialise anything and is not a
-- substitute for the lock -- it converts a silent wrong balance into a failed
-- transaction, which is the difference between a bug that is discovered in a
-- ledger reconciliation months later and one that is discovered immediately.
--
-- ## Why NOT VALID
--
-- Added NOT VALID deliberately. Postgres then enforces the constraint on
-- every INSERT and UPDATE from this point on -- which is the entire coverage
-- this is for, because the rows at risk are the ones not yet written -- while
-- skipping the full-table scan that would otherwise take an ACCESS EXCLUSIVE
-- lock, and, more to the point, while not being able to fail the deploy on
-- historical data nobody has surveyed yet.
--
-- Validation is a second, separate migration, and it comes after the survey:
--
--   1. this migration deploys (safe against any existing data);
--   2. `npm run report:credit-lot-invariants` runs against production and
--      reports every violating row, if any;
--   3. once that reads zero -- correcting any row it finds through the
--      ledger, never by hand -- a follow-up migration runs
--      `ALTER TABLE "CreditLot" VALIDATE CONSTRAINT ...`.
--
-- Do NOT validate by hand in production between (1) and (3).
-- `scripts/compare-schema-to-migrations.mjs` compares
-- `pg_get_constraintdef()`, whose output carries the `NOT VALID` suffix, so a
-- hand-validated production would read as schema drift against the migration
-- history for as long as the follow-up migration is missing.

ALTER TABLE "CreditLot"
    ADD CONSTRAINT "CreditLot_remainingCredits_non_negative_check"
    CHECK ("remainingCredits" >= 0)
    NOT VALID;

-- The funded-cost half of the same lot. It is decremented by the same call in
-- the same loop, so leaving it unguarded would leave the money side of an
-- over-reservation invisible while the credit side failed closed.
ALTER TABLE "CreditLot"
    ADD CONSTRAINT "CreditLot_remainingFundedCost_non_negative_check"
    CHECK ("remainingFundedCostMicroUsd" >= 0)
    NOT VALID;
