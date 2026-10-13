-- Policy v40 admits one separately configured native API executor while
-- preserving the existing disabled and CLI runtime states. The API launch
-- scope is exact at the database boundary; it never relies on SQL CHECK's
-- acceptance of NULL expressions for absent CLI-only keys.
BEGIN;

ALTER TABLE "AmuxWorkerRuntime"
  DROP CONSTRAINT "AmuxWorkerRuntime_protocolCapabilities_check",
  ADD CONSTRAINT "AmuxWorkerRuntime_protocolCapabilities_check" CHECK (
    "protocolCapabilities" IN (
      ARRAY[]::TEXT[],
      ARRAY['read_only_retry_v1']::TEXT[],
      ARRAY['read_only_api_retry_v1']::TEXT[]));

ALTER TABLE "AmuxV22ReadOnlyLaunchCheck"
  DROP CONSTRAINT "AmuxV22ReadOnlyLaunchCheck_shape_check",
  ADD CONSTRAINT "AmuxV22ReadOnlyLaunchCheck_shape_check" CHECK (
    "taskId" = 'c48886b9-86f8-4631-8db8-c0b288a707af' AND
    "priorAttemptId" = '97858395-3d66-42fa-9bfb-0e5a6cba9bd8' AND
    "targetHost" = 'amux-ubuntu' AND "workerGeneration" >= 1 AND
    "provider" = 'anthropic' AND "modelId" ~ '^claude-[A-Za-z0-9._-]{1,120}$' AND
    "additionalCapMicroUsd" BETWEEN 1 AND 3400000 AND
    "worstExposureMicroUsd" = 3400000 + "additionalCapMicroUsd" AND
    "worstExposureMicroUsd" <= 6800000 AND
    "requestDigest" ~ '^[a-f0-9]{64}$' AND
    "riskAcceptanceDigest" ~ '^[a-f0-9]{64}$' AND
    "sourceEvidenceDigest" ~ '^[a-f0-9]{64}$' AND
    "briefDigest" ~ '^[a-f0-9]{64}$' AND
    "routePolicyDigest" ~ '^[a-f0-9]{64}$' AND
    "costReceiptDigest" ~ '^[a-f0-9]{64}$' AND
    "costDigest" ~ '^[a-f0-9]{64}$' AND
    "launchScopeDigest" ~ '^[a-f0-9]{64}$' AND
    jsonb_typeof("launchScope") = 'object' AND pg_column_size("launchScope") <= 2048 AND
    "launchScope"->>'version' = '1' AND (
      (NOT ("launchScope" ? 'executorKind') AND
        "launchScope"->>'launcherPolicyVersion' = 'amux-v22-read-only-retry-v1' AND
        "launchScope"->>'role' = 'investigate' AND
        "launchScope"->'allowedTools' = '["Glob","Grep","Read"]'::jsonb)
      OR
      (("launchScope" - ARRAY['version', 'executorKind',
          'launcherConfigDigest', 'apiExecutionFrameDigest']::TEXT[]) = '{}'::jsonb AND
        "launchScope" ? 'version' AND
        "launchScope" ? 'executorKind' AND
        "launchScope" ? 'launcherConfigDigest' AND
        "launchScope" ? 'apiExecutionFrameDigest' AND
        "launchScope"->>'executorKind' = 'read_only_api_retry_v1' AND
        "launchScope"->>'launcherConfigDigest' ~ '^[a-f0-9]{64}$' AND
        "launchScope"->>'apiExecutionFrameDigest' ~ '^[a-f0-9]{64}$')
    ));

COMMIT;
