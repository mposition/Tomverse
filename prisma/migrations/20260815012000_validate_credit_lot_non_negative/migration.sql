-- Validate the two CreditLot non-negative CHECKs added NOT VALID by
-- 20260812070000_credit_lot_non_negative.
--
-- Contract: docs/policy/credit-and-cost-limits.md §9.
-- Procedure: .github/RELEASE_CHECKLIST.md §7.7.
--
-- Step (3) of the sequence that migration wrote down. Steps (1) and (2) are
-- done: the constraints deployed and have been enforcing every INSERT and
-- UPDATE since, and `npm run report:credit-lot-invariants` was run against
-- production from the deployed release SHA on 2026-08-15 and reported
--
--     Present but NOT VALID: CreditLot_remainingCredits_non_negative_check,
--                            CreditLot_remainingFundedCost_non_negative_check.
--     Lots violating the non-negative invariant: 0
--
-- Zero violating rows is what makes this migration a formality rather than a
-- gamble: VALIDATE re-reads every existing row and fails the migration if any
-- one of them breaks the CHECK, so running it before the survey would be
-- deploying a statement whose outcome nobody had looked at.
--
-- ## Why this is a migration and not a psql session
--
-- Hand-validating production would leave `pg_get_constraintdef()` -- whose
-- output carries the `NOT VALID` suffix -- disagreeing with what the migration
-- history builds, and `scripts/compare-schema-to-migrations.mjs` compares
-- exactly that string between a shadow database built from these files and the
-- real one. The drift would be reported for as long as this file was missing,
-- and the fix for it would be this file, written later and under less
-- attention.
--
-- ## Locking
--
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, not ACCESS EXCLUSIVE: it
-- scans the table while reads and writes continue. `CreditLot` is small and
-- the scan is a sequential pass over an already-clean table, which is the
-- other half of why the NOT VALID split was worth making.

ALTER TABLE "CreditLot"
    VALIDATE CONSTRAINT "CreditLot_remainingCredits_non_negative_check";

ALTER TABLE "CreditLot"
    VALIDATE CONSTRAINT "CreditLot_remainingFundedCost_non_negative_check";
