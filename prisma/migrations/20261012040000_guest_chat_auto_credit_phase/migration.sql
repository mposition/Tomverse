-- Guest Smart Adaptive uses the existing financial reservation row for a
-- content-free, model-agnostic Guest credit hold. Historical and ordinary
-- rows remain exact by default; deploying this migration creates no hold and
-- enables no product capability.

ALTER TABLE "ChatCreditReservation"
    ADD COLUMN "phase" TEXT NOT NULL DEFAULT 'exact';

ALTER TABLE "ChatCreditReservation"
    ADD COLUMN "clientTurnId" TEXT;

CREATE UNIQUE INDEX "ChatCreditReservation_subjectKey_clientTurnId_key"
    ON "ChatCreditReservation"("subjectKey", "clientTurnId");

ALTER TABLE "ChatCreditReservation"
    ADD CONSTRAINT "ChatCreditReservation_phase_check"
    CHECK ("phase" IN ('exact', 'guest_auto_prehold'));

-- A prehold is deliberately undispatched and carries no token/provider-cost
-- authorization. provider/model identify only the maximum-credit basis
-- candidate. The distinct status keeps it outside the ordinary `reserved`
-- expiry reconciler; expiry is not proof that the Refiner did not run.
ALTER TABLE "ChatCreditReservation"
    ADD CONSTRAINT "ChatCreditReservation_guest_auto_prehold_shape_check"
    CHECK (
        "phase" = 'exact'
        OR (
            "userId" IS NULL
            AND "clientTurnId" IS NOT NULL
            AND "source" = 'chat'
            AND "status" IN (
                'guest_auto_preheld',
                'guest_auto_released',
                'guest_auto_unknown'
            )
            AND "idempotencyKey" LIKE 'guest-auto-credit:v1:%'
            AND "providerRequestId" IS NULL
            AND "providerResponseId" IS NULL
            AND "providerRequestLinkedAt" IS NULL
            AND "reservedCredits" > 0
            AND "reservedCostMicroUsd" = 0
            AND "planReservedCredits" = 0
            AND "addOnReservedCredits" = 0
            AND "settledCredits" = 0
            AND "settledCostMicroUsd" = 0
            AND "settledInputTokens" = 0
            AND "settledCachedInputTokens" = 0
            AND "settledCacheWriteInputTokens" = 0
            AND "settledOutputTokens" = 0
            AND "pricingSnapshot" IS NULL
            AND "providerUsageSnapshot" IS NULL
            AND "settlementAttemptIndex" IS NULL
            AND jsonb_typeof("reservationPayload") = 'object'
            AND "reservationPayload" ->> 'phase' = 'guest_auto_prehold'
        )
    );

CREATE OR REPLACE FUNCTION "chat_guest_auto_credit_phase_guard"()
RETURNS TRIGGER AS $$
DECLARE
    old_credit_entries JSONB;
    old_minute_entries JSONB;
    new_entries JSONB;
    entry_index INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."phase" = 'guest_auto_prehold' THEN
            IF NEW."status" <> 'guest_auto_preheld'
               OR NEW."outcome" IS NOT NULL
               OR NEW."settledAt" IS NOT NULL
               OR NEW."reconciledAt" IS NOT NULL
               OR NEW."lastError" IS NOT NULL
               OR NEW."idempotencyKey" NOT LIKE 'guest-auto-credit:v1:%'
               OR NEW."reservationPayload" ->> 'requestKey' IS DISTINCT FROM NEW."idempotencyKey"
               OR NEW."reservationPayload" ->> 'reservationId' IS DISTINCT FROM NEW."id"
               OR NEW."reservationPayload" ->> 'traceId' IS DISTINCT FROM NEW."traceId"
               OR NEW."reservationPayload" ->> 'clientTurnId' IS DISTINCT FROM NEW."clientTurnId"
               OR NEW."clientTurnId" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
               OR NEW."reservationPayload" ->> 'phase' IS DISTINCT FROM 'guest_auto_prehold'
               OR NEW."reservationPayload" ->> 'version' IS DISTINCT FROM '1'
               OR ((NEW."reservationPayload" ->> 'authorityId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS DISTINCT FROM TRUE
               OR ((NEW."reservationPayload" ->> 'candidateDigest') ~ '^[a-f0-9]{64}$') IS DISTINCT FROM TRUE
               OR ((NEW."reservationPayload" ->> 'reachableCandidateDigest') ~ '^[a-f0-9]{64}$') IS DISTINCT FROM TRUE
               OR ((NEW."reservationPayload" ->> 'sourceCommitSha') ~ '^[a-f0-9]{40}$') IS DISTINCT FROM TRUE
               OR ((NEW."reservationPayload" ->> 'runtimeDeploymentId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS DISTINCT FROM TRUE
               OR ((NEW."reservationPayload" ->> 'activationPairDigest') ~ '^[a-f0-9]{64}$') IS DISTINCT FROM TRUE
               OR ((NEW."reservationPayload" ->> 'configDigest') ~ '^[a-f0-9]{64}$') IS DISTINCT FROM TRUE
               OR NEW."reservationPayload" ->> 'preholdAuditLogId' IS NULL
               OR NEW."reservationPayload" ->> 'basisModelId' IS DISTINCT FROM NEW."modelId"
               OR NEW."reservationPayload" ->> 'basisProvider' IS DISTINCT FROM NEW."provider"
               OR (NEW."reservationPayload" ->> 'heldCredits')::INTEGER IS DISTINCT FROM NEW."reservedCredits"
               OR jsonb_typeof(NEW."reservationPayload" -> 'minuteEntries') IS DISTINCT FROM 'array'
               OR jsonb_array_length(NEW."reservationPayload" -> 'minuteEntries') <> 2
               OR jsonb_typeof(NEW."reservationPayload" -> 'creditEntries') IS DISTINCT FROM 'array'
               OR jsonb_array_length(NEW."reservationPayload" -> 'creditEntries') <> 4 THEN
                RAISE EXCEPTION 'Guest Auto credit prehold % has an invalid binding', NEW."id"
                    USING ERRCODE = 'check_violation';
            END IF;

            old_minute_entries := NEW."reservationPayload" -> 'minuteEntries';
            old_credit_entries := NEW."reservationPayload" -> 'creditEntries';
            IF old_minute_entries -> 0 ->> 'key' IS DISTINCT FROM NEW."subjectKey"
               OR old_minute_entries -> 0 ->> 'period' IS DISTINCT FROM 'minute'
               OR old_minute_entries -> 0 ->> 'amount' IS DISTINCT FROM '1'
               OR old_minute_entries -> 1 ->> 'period' IS DISTINCT FROM 'minute'
               OR old_minute_entries -> 1 ->> 'amount' IS DISTINCT FROM '1'
               OR old_minute_entries -> 1 ->> 'key' IS NULL
               OR old_credit_entries -> 0 ->> 'key' IS DISTINCT FROM NEW."subjectKey"
               OR old_credit_entries -> 0 ->> 'period' IS DISTINCT FROM 'day'
               OR old_credit_entries -> 1 ->> 'key' IS DISTINCT FROM NEW."subjectKey"
               OR old_credit_entries -> 1 ->> 'period' IS DISTINCT FROM 'month'
               OR old_credit_entries -> 2 ->> 'key' IS DISTINCT FROM old_minute_entries -> 1 ->> 'key'
               OR old_credit_entries -> 2 ->> 'period' IS DISTINCT FROM 'guest-ip-day'
               OR old_credit_entries -> 3 ->> 'key' IS DISTINCT FROM old_minute_entries -> 1 ->> 'key'
               OR old_credit_entries -> 3 ->> 'period' IS DISTINCT FROM 'guest-ip-month'
               OR old_credit_entries -> 0 ->> 'amount' IS DISTINCT FROM NEW."reservedCredits"::TEXT
               OR old_credit_entries -> 1 ->> 'amount' IS DISTINCT FROM NEW."reservedCredits"::TEXT
               OR old_credit_entries -> 2 ->> 'amount' IS DISTINCT FROM NEW."reservedCredits"::TEXT
               OR old_credit_entries -> 3 ->> 'amount' IS DISTINCT FROM NEW."reservedCredits"::TEXT
               OR old_credit_entries -> 0 ->> 'periodStart' IS DISTINCT FROM old_credit_entries -> 2 ->> 'periodStart'
               OR old_credit_entries -> 1 ->> 'periodStart' IS DISTINCT FROM old_credit_entries -> 3 ->> 'periodStart' THEN
                RAISE EXCEPTION 'Guest Auto credit prehold % has invalid usage periods', NEW."id"
                    USING ERRCODE = 'check_violation';
            END IF;
        ELSIF NEW."clientTurnId" IS NOT NULL
              OR NEW."idempotencyKey" LIKE 'guest-auto-credit:v1:%'
              OR NEW."status" IN ('guest_auto_preheld', 'guest_auto_released', 'guest_auto_unknown') THEN
            RAISE EXCEPTION 'Guest Auto credit rows must start as a prehold'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."phase" = 'exact' AND NEW."phase" <> 'exact' THEN
        RAISE EXCEPTION 'ChatCreditReservation % cannot return to a prehold', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."phase" = 'guest_auto_prehold' THEN
        IF NEW."id" IS DISTINCT FROM OLD."id"
           OR NEW."userId" IS DISTINCT FROM OLD."userId"
           OR NEW."subjectKey" IS DISTINCT FROM OLD."subjectKey"
           OR NEW."traceId" IS DISTINCT FROM OLD."traceId"
           OR NEW."clientTurnId" IS DISTINCT FROM OLD."clientTurnId"
           OR NEW."source" IS DISTINCT FROM OLD."source"
           OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
           OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
            RAISE EXCEPTION 'Guest Auto credit prehold % binding is immutable', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;

        IF OLD."status" <> 'guest_auto_preheld' THEN
            RAISE EXCEPTION 'Guest Auto credit prehold % is already terminal', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;

        IF NEW."phase" = 'guest_auto_prehold' THEN
            IF NEW."status" NOT IN ('guest_auto_released', 'guest_auto_unknown')
               OR NEW."provider" IS DISTINCT FROM OLD."provider"
               OR NEW."modelId" IS DISTINCT FROM OLD."modelId"
               OR NEW."reservationPayload" IS DISTINCT FROM OLD."reservationPayload"
               OR NEW."reservedCredits" IS DISTINCT FROM OLD."reservedCredits"
               OR NEW."reservedCostMicroUsd" IS DISTINCT FROM OLD."reservedCostMicroUsd"
               OR NEW."planReservedCredits" IS DISTINCT FROM OLD."planReservedCredits"
               OR NEW."addOnReservedCredits" IS DISTINCT FROM OLD."addOnReservedCredits"
               OR NEW."settledCredits" IS DISTINCT FROM OLD."settledCredits"
               OR NEW."settledCostMicroUsd" IS DISTINCT FROM OLD."settledCostMicroUsd"
               OR NEW."settledInputTokens" IS DISTINCT FROM OLD."settledInputTokens"
               OR NEW."settledCachedInputTokens" IS DISTINCT FROM OLD."settledCachedInputTokens"
               OR NEW."settledCacheWriteInputTokens" IS DISTINCT FROM OLD."settledCacheWriteInputTokens"
               OR NEW."settledOutputTokens" IS DISTINCT FROM OLD."settledOutputTokens"
               OR NEW."pricingSnapshot" IS DISTINCT FROM OLD."pricingSnapshot"
               OR NEW."providerUsageSnapshot" IS DISTINCT FROM OLD."providerUsageSnapshot"
               OR NEW."providerRequestId" IS DISTINCT FROM OLD."providerRequestId"
               OR NEW."providerResponseId" IS DISTINCT FROM OLD."providerResponseId"
               OR NEW."providerRequestLinkedAt" IS DISTINCT FROM OLD."providerRequestLinkedAt"
               OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
               OR NEW."lastError" IS DISTINCT FROM OLD."lastError"
               OR NEW."settlementAttemptIndex" IS DISTINCT FROM OLD."settlementAttemptIndex"
               OR (NEW."status" = 'guest_auto_released' AND (
                    NEW."outcome" IS DISTINCT FROM 'failed'
                    OR NEW."settledAt" IS NULL
                    OR NEW."reconciledAt" IS NULL
               ))
               OR (NEW."status" = 'guest_auto_unknown' AND (
                    NEW."outcome" IS DISTINCT FROM OLD."outcome"
                    OR NEW."settledAt" IS DISTINCT FROM OLD."settledAt"
                    OR NEW."reconciledAt" IS NULL
               )) THEN
                RAISE EXCEPTION 'Guest Auto credit prehold % terminal transition is invalid', OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END IF;

        IF NEW."phase" <> 'exact'
           OR NEW."status" <> 'reserved'
           OR NEW."idempotencyKey" NOT LIKE 'guest-auto-credit:v1:%'
           OR NEW."reservedCredits" <= 0
           OR NEW."reservedCredits" > OLD."reservedCredits"
           OR NEW."userId" IS NOT NULL
           OR NEW."source" <> 'chat'
           OR NEW."providerRequestId" IS NOT NULL
           OR NEW."providerResponseId" IS NOT NULL
           OR NEW."providerRequestLinkedAt" IS NOT NULL
           OR NEW."outcome" IS NOT NULL
           OR NEW."settledCredits" <> 0
           OR NEW."settledCostMicroUsd" <> 0
           OR NEW."settledInputTokens" <> 0
           OR NEW."settledCachedInputTokens" <> 0
           OR NEW."settledCacheWriteInputTokens" <> 0
           OR NEW."settledOutputTokens" <> 0
           OR NEW."pricingSnapshot" IS NOT NULL
           OR NEW."providerUsageSnapshot" IS NOT NULL
           OR NEW."settledAt" IS NOT NULL
           OR NEW."reconciledAt" IS NOT NULL
           OR NEW."lastError" IS NOT NULL
           OR NEW."settlementAttemptIndex" IS NOT NULL
           OR NEW."reservationPayload" #>> '{guestAuto,authorityId}' IS DISTINCT FROM OLD."reservationPayload" ->> 'authorityId'
           OR NEW."reservationPayload" #>> '{guestAuto,requestKey}' IS DISTINCT FROM OLD."idempotencyKey"
           OR NEW."reservationPayload" #>> '{guestAuto,clientTurnId}' IS DISTINCT FROM OLD."clientTurnId"
           OR NEW."reservationPayload" #>> '{guestAuto,candidateDigest}' IS DISTINCT FROM OLD."reservationPayload" ->> 'candidateDigest'
           OR NEW."reservationPayload" #>> '{guestAuto,reachableCandidateDigest}' IS DISTINCT FROM OLD."reservationPayload" ->> 'reachableCandidateDigest'
           OR NEW."reservationPayload" #>> '{guestAuto,sourceCommitSha}' IS DISTINCT FROM OLD."reservationPayload" ->> 'sourceCommitSha'
           OR NEW."reservationPayload" #>> '{guestAuto,runtimeDeploymentId}' IS DISTINCT FROM OLD."reservationPayload" ->> 'runtimeDeploymentId'
           OR NEW."reservationPayload" #>> '{guestAuto,activationPairDigest}' IS DISTINCT FROM OLD."reservationPayload" ->> 'activationPairDigest'
           OR NEW."reservationPayload" #>> '{guestAuto,configDigest}' IS DISTINCT FROM OLD."reservationPayload" ->> 'configDigest'
           OR NEW."reservationPayload" #>> '{guestAuto,basisModelId}' IS DISTINCT FROM OLD."modelId"
           OR NEW."reservationPayload" #>> '{guestAuto,basisProvider}' IS DISTINCT FROM OLD."provider"
           OR NEW."reservationPayload" #>> '{guestAuto,finalModelId}' IS DISTINCT FROM NEW."modelId"
           OR NEW."reservationPayload" #>> '{guestAuto,finalProvider}' IS DISTINCT FROM NEW."provider"
           OR NEW."reservationPayload" #>> '{guestAuto,preholdAuditLogId}' IS DISTINCT FROM OLD."reservationPayload" ->> 'preholdAuditLogId'
           OR NEW."reservationPayload" #>> '{guestAuto,conversionAuditLogId}' IS NULL
           OR NEW."reservationPayload" #>> '{guestAuto,heldCredits}' IS DISTINCT FROM OLD."reservedCredits"::TEXT
           OR NEW."reservationPayload" #>> '{guestAuto,exactCredits}' IS DISTINCT FROM NEW."reservedCredits"::TEXT THEN
            RAISE EXCEPTION 'Guest Auto credit prehold % exact conversion is invalid', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;

        old_credit_entries := OLD."reservationPayload" -> 'creditEntries';
        new_entries := NEW."reservationPayload" -> 'entries';
        IF jsonb_typeof(new_entries) IS DISTINCT FROM 'array' OR jsonb_array_length(new_entries) < 4 THEN
            RAISE EXCEPTION 'Guest Auto credit prehold % lost its original credit periods', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        FOR entry_index IN 0..3 LOOP
            IF new_entries -> entry_index ->> 'key' IS DISTINCT FROM old_credit_entries -> entry_index ->> 'key'
               OR new_entries -> entry_index ->> 'period' IS DISTINCT FROM old_credit_entries -> entry_index ->> 'period'
               OR new_entries -> entry_index ->> 'periodStart' IS DISTINCT FROM old_credit_entries -> entry_index ->> 'periodStart'
               OR new_entries -> entry_index ->> 'metric' IS DISTINCT FROM 'credits'
               OR new_entries -> entry_index ->> 'amount' IS DISTINCT FROM NEW."reservedCredits"::TEXT THEN
                RAISE EXCEPTION 'Guest Auto credit prehold % changed an original credit period', OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;
        END LOOP;
        RETURN NEW;
    END IF;

    -- A converted Guest Auto reservation may become unknown, but it keeps all
    -- money and usage holds. No current contract resolves or refunds it.
    IF OLD."idempotencyKey" LIKE 'guest-auto-credit:v1:%'
       AND NEW."status" = 'guest_auto_unknown' THEN
        IF OLD."status" <> 'reserved'
           OR NEW."phase" <> 'exact'
           OR NEW."reconciledAt" IS NULL
           OR NEW."id" IS DISTINCT FROM OLD."id"
           OR NEW."userId" IS DISTINCT FROM OLD."userId"
           OR NEW."subjectKey" IS DISTINCT FROM OLD."subjectKey"
           OR NEW."traceId" IS DISTINCT FROM OLD."traceId"
           OR NEW."clientTurnId" IS DISTINCT FROM OLD."clientTurnId"
           OR NEW."source" IS DISTINCT FROM OLD."source"
           OR NEW."provider" IS DISTINCT FROM OLD."provider"
           OR NEW."modelId" IS DISTINCT FROM OLD."modelId"
           OR NEW."outcome" IS DISTINCT FROM OLD."outcome"
           OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
           OR NEW."providerRequestId" IS DISTINCT FROM OLD."providerRequestId"
           OR NEW."providerResponseId" IS DISTINCT FROM OLD."providerResponseId"
           OR NEW."providerRequestLinkedAt" IS DISTINCT FROM OLD."providerRequestLinkedAt"
           OR NEW."reservationPayload" IS DISTINCT FROM OLD."reservationPayload"
           OR NEW."reservedCredits" IS DISTINCT FROM OLD."reservedCredits"
           OR NEW."reservedCostMicroUsd" IS DISTINCT FROM OLD."reservedCostMicroUsd"
           OR NEW."planReservedCredits" IS DISTINCT FROM OLD."planReservedCredits"
           OR NEW."addOnReservedCredits" IS DISTINCT FROM OLD."addOnReservedCredits"
           OR NEW."settledCredits" IS DISTINCT FROM OLD."settledCredits"
           OR NEW."settledCostMicroUsd" IS DISTINCT FROM OLD."settledCostMicroUsd"
           OR NEW."settledInputTokens" IS DISTINCT FROM OLD."settledInputTokens"
           OR NEW."settledCachedInputTokens" IS DISTINCT FROM OLD."settledCachedInputTokens"
           OR NEW."settledCacheWriteInputTokens" IS DISTINCT FROM OLD."settledCacheWriteInputTokens"
           OR NEW."settledOutputTokens" IS DISTINCT FROM OLD."settledOutputTokens"
           OR NEW."pricingSnapshot" IS DISTINCT FROM OLD."pricingSnapshot"
           OR NEW."providerUsageSnapshot" IS DISTINCT FROM OLD."providerUsageSnapshot"
           OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
           OR NEW."settledAt" IS DISTINCT FROM OLD."settledAt"
           OR NEW."lastError" IS DISTINCT FROM OLD."lastError"
           OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
           OR NEW."settlementAttemptIndex" IS DISTINCT FROM OLD."settlementAttemptIndex" THEN
            RAISE EXCEPTION 'Guest Auto exact reservation % unknown transition is invalid', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."status" = 'guest_auto_unknown'
       OR NEW."status" IN ('guest_auto_preheld', 'guest_auto_released', 'guest_auto_unknown') THEN
        RAISE EXCEPTION 'Guest Auto credit reservation % transition is invalid', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chat_guest_auto_credit_phase_guard_trigger"
BEFORE INSERT OR UPDATE ON "ChatCreditReservation"
FOR EACH ROW EXECUTE FUNCTION "chat_guest_auto_credit_phase_guard"();
