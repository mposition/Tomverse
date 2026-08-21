-- The billing country, kept beside the self-declared one.
--
-- Contract: docs/policy/email-notifications.md §6.2.
--
-- Two columns rather than one because the contract's conflict case needs both
-- values at once. Folded into a single column, a payment method reporting a
-- different country from the one the person entered would simply overwrite it,
-- and the disagreement -- which holds marketing back and asks them -- would be
-- invisible rather than handled.
--
-- Additive and nullable: existing accounts have no billing country until their
-- next checkout, which resolves to "unconfirmed" and is the honest answer.
-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN     "billingCountry" TEXT,
ADD COLUMN     "billingCountryUpdatedAt" TIMESTAMP(3);
