-- Survey: the error classes already on RoutingAttempt, and whether the A-3b
-- CHECK can be validated.
--
-- Paste this whole file into the Railway Postgres console, the Prisma Studio
-- SQL console, or psql. It needs no clone, no npm install and no environment
-- variables. `npm run report:routing-attempt-error-classes` is the same
-- survey for anyone who can run the repository.
--
-- READ ONLY. Every statement is a SELECT. Nothing is created, altered or
-- deleted, and there is no transaction to roll back.
--
-- SAFE TO PASTE THE OUTPUT ANYWHERE. It returns class names, counts and
-- timestamps to the day. No user id, no trace id, no model id, no provider
-- error text, no message content. That is a property of what is selected
-- rather than a promise about the data.
--
-- ---------------------------------------------------------------------------
-- What this is for
-- ---------------------------------------------------------------------------
--
-- `RoutingAttempt_errorClass_check` ships NOT VALID. It enforces every write
-- from its deploy onward and says nothing about rows that already existed --
-- deliberately, because a validating constraint would have made that deploy
-- fail on data nobody had looked at.
--
--   1. the NOT VALID migration deploys;
--   2. this runs and reports every distinct value;
--   3. once query 3 returns no rows, a follow-up *migration* validates it.
--
-- Do not run VALIDATE CONSTRAINT by hand. The schema comparison reads that as
-- drift and the next deploy fights it.

-- ---------------------------------------------------------------------------
-- 1. Is instrumentation writing at all?
-- ---------------------------------------------------------------------------
--
-- This answers the ROUTING_DISPATCH_INSTRUMENTATION question empirically,
-- which is stronger than reading the variable: the variable existing does not
-- mean it is on. Anything other than exactly `observe` or `enforce` is read as
-- `off`, and `off` makes `beginInstrumentedDispatch()` return null before any
-- row is written. A typo is a silent off.
--
--   attempts = 0            -> instrumentation has never written here.
--   last_attempt is old     -> it was on once and is not now.
--   last_attempt is recent  -> it is on.

SELECT
    COUNT(*)                                   AS attempts,
    COUNT(*) FILTER (WHERE "errorClass" IS NOT NULL) AS classified,
    COUNT(*) FILTER (WHERE "errorClass" IS NULL)     AS unclassified,
    MIN("createdAt")::date                     AS first_attempt,
    MAX("createdAt")::date                     AS last_attempt,
    COUNT(*) FILTER (WHERE "createdAt" > now() - interval '24 hours') AS last_24h
FROM "RoutingAttempt";

-- ---------------------------------------------------------------------------
-- 2. Which step of the sequence is this database on?
-- ---------------------------------------------------------------------------
--
--   no row       -> the A-3b migration has not been applied here.
--   validated=f  -> NOT VALID. Existing rows unchecked. This survey applies.
--   validated=t  -> already validated. Nothing to do.

SELECT
    conname      AS constraint_name,
    convalidated AS validated
FROM pg_constraint
WHERE conrelid = '"RoutingAttempt"'::regclass
  AND conname = 'RoutingAttempt_errorClass_check';

-- ---------------------------------------------------------------------------
-- 3. Values outside the vocabulary
-- ---------------------------------------------------------------------------
--
-- **This is the one that decides.** No rows returned means the constraint can
-- be validated. Any row returned is a decision before it can:
--
--   - the value belongs in the list -> add it, in its own change, with the
--     reason it exists;
--   - it was a writer mistake       -> the rows need correcting, which is a
--     migration with an owner and not something a survey should do.
--
-- The list below is `ROUTING_ATTEMPT_ERROR_CLASSES` in
-- lib/routingAttemptStore.ts, eighteen values. NULL is not a violation: a
-- successful attempt has nothing to classify, and the constraint permits it.

SELECT
    "errorClass" AS unknown_class,
    COUNT(*)     AS rows,
    MIN("createdAt")::date AS first_seen,
    MAX("createdAt")::date AS last_seen
FROM "RoutingAttempt"
WHERE "errorClass" IS NOT NULL
  AND "errorClass" NOT IN (
      'empty_response',
      'first_token_deadline_exceeded',
      'request_failed',
      'process_stopped_after_dispatch',
      'client_gone',
      'completion_handling_failed',
      'provider_pre_token_failure',
      'provider_policy_refusal',
      'provider_payment_required',
      'provider_rate_limited',
      'provider_server_error',
      'provider_network',
      'provider_authentication',
      'provider_request_contract',
      'provider_model_not_found',
      'provider_model_transient',
      'provider_local_rejection',
      'provider_unknown'
  )
GROUP BY "errorClass"
ORDER BY COUNT(*) DESC;

-- ---------------------------------------------------------------------------
-- 4. The full distribution
-- ---------------------------------------------------------------------------
--
-- Not needed for the decision -- query 3 is -- but it is what makes the answer
-- readable. `in_vocabulary = false` marks the same rows query 3 returns.

SELECT
    COALESCE("errorClass", '(null)') AS class,
    COUNT(*)                         AS rows,
    ROUND(100.0 * COUNT(*) / NULLIF(SUM(COUNT(*)) OVER (), 0), 2) AS pct,
    "errorClass" IS NULL OR "errorClass" IN (
        'empty_response',
        'first_token_deadline_exceeded',
        'request_failed',
        'process_stopped_after_dispatch',
        'client_gone',
        'completion_handling_failed',
        'provider_pre_token_failure',
        'provider_policy_refusal',
        'provider_payment_required',
        'provider_rate_limited',
        'provider_server_error',
        'provider_network',
        'provider_authentication',
        'provider_request_contract',
        'provider_model_not_found',
        'provider_model_transient',
        'provider_local_rejection',
        'provider_unknown'
    ) AS in_vocabulary
FROM "RoutingAttempt"
GROUP BY "errorClass"
ORDER BY COUNT(*) DESC;

-- ---------------------------------------------------------------------------
-- Reading the result
-- ---------------------------------------------------------------------------
--
--   query 1 attempts = 0
--       Instrumentation is not writing. Validating an empty table proves
--       nothing -- it would pass today and say nothing about the rows that
--       arrive tomorrow. Turn instrumentation on, wait for a real sample, and
--       run this again.
--
--   query 2 returns no row
--       The A-3b migration is not applied to this database.
--
--   query 3 returns rows
--       Those values fail the constraint. VALIDATE would fail today.
--
--   query 3 returns nothing, and query 1 shows a real sample
--       The constraint can be validated. In a migration, not by hand:
--
--           ALTER TABLE "RoutingAttempt"
--               VALIDATE CONSTRAINT "RoutingAttempt_errorClass_check";
--
--       VALIDATE takes SHARE UPDATE EXCLUSIVE, so reads and writes continue
--       while it scans.
