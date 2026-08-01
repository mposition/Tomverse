-- Store the provider's request-level billing snapshot separately from the
-- Tomverse model-rate snapshot used when the request was reserved.
ALTER TABLE "ChatCreditReservation"
ADD COLUMN "providerUsageSnapshot" JSONB;
