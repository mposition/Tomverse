-- Provider credentials and outbound destinations are security policy, not
-- catalogue data. Preserve every mismatch for incident review before
-- normalizing rows and enforcing the allowlist.
WITH "ExpectedProviderConnection"("provider", "apiBaseUrl", "apiKeyEnvName") AS (
  VALUES
    ('openai', 'https://api.openai.com/v1', 'OPENAI_API_KEY'),
    ('anthropic', 'https://api.anthropic.com', 'ANTHROPIC_API_KEY'),
    ('google', 'https://generativelanguage.googleapis.com/v1beta', 'GOOGLE_GENERATIVE_AI_API_KEY'),
    ('groq', 'https://api.groq.com/openai/v1', 'GROQ_API_KEY'),
    ('xai', 'https://api.x.ai/v1', 'XAI_API_KEY'),
    ('deepseek', 'https://api.deepseek.com', 'DEEPSEEK_API_KEY'),
    ('mistral', 'https://api.mistral.ai/v1', 'MISTRAL_API_KEY'),
    ('moonshot', 'https://api.moonshot.ai/v1', 'MOONSHOT_API_KEY'),
    ('qwen', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY'),
    ('zhipu', 'https://api.z.ai/api/paas/v4', 'ZHIPU_API_KEY'),
    ('perplexity', 'https://api.perplexity.ai', 'PERPLEXITY_API_KEY')
)
INSERT INTO "AdminAuditLog" (
  "id", "action", "targetType", "targetId", "summary", "metadata", "createdAt"
)
SELECT
  md5(random()::text || clock_timestamp()::text || model."id"),
  'model_registry.connection_security_finding',
  'ModelRegistryEntry',
  model."id",
  'A non-standard provider endpoint or credential selector was found before the connection allowlist migration.',
  jsonb_build_object(
    'provider', model."provider",
    'previousApiBaseUrl', model."apiBaseUrl",
    'previousApiKeyEnvName', model."apiKeyEnvName",
    'expectedApiBaseUrl', expected."apiBaseUrl",
    'expectedApiKeyEnvName', expected."apiKeyEnvName",
    'supportedProvider', expected."provider" IS NOT NULL
  ),
  NOW()
FROM "ModelRegistryEntry" model
LEFT JOIN "ExpectedProviderConnection" expected
  ON expected."provider" = model."provider"
WHERE expected."provider" IS NULL
   OR model."apiBaseUrl" IS DISTINCT FROM expected."apiBaseUrl"
   OR model."apiKeyEnvName" IS DISTINCT FROM expected."apiKeyEnvName";

UPDATE "ModelRegistryEntry"
SET
  "apiBaseUrl" = CASE "provider"
    WHEN 'openai' THEN 'https://api.openai.com/v1'
    WHEN 'anthropic' THEN 'https://api.anthropic.com'
    WHEN 'google' THEN 'https://generativelanguage.googleapis.com/v1beta'
    WHEN 'groq' THEN 'https://api.groq.com/openai/v1'
    WHEN 'xai' THEN 'https://api.x.ai/v1'
    WHEN 'deepseek' THEN 'https://api.deepseek.com'
    WHEN 'mistral' THEN 'https://api.mistral.ai/v1'
    WHEN 'moonshot' THEN 'https://api.moonshot.ai/v1'
    WHEN 'qwen' THEN 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
    WHEN 'zhipu' THEN 'https://api.z.ai/api/paas/v4'
    WHEN 'perplexity' THEN 'https://api.perplexity.ai'
    ELSE 'https://invalid.invalid'
  END,
  "apiKeyEnvName" = CASE "provider"
    WHEN 'openai' THEN 'OPENAI_API_KEY'
    WHEN 'anthropic' THEN 'ANTHROPIC_API_KEY'
    WHEN 'google' THEN 'GOOGLE_GENERATIVE_AI_API_KEY'
    WHEN 'groq' THEN 'GROQ_API_KEY'
    WHEN 'xai' THEN 'XAI_API_KEY'
    WHEN 'deepseek' THEN 'DEEPSEEK_API_KEY'
    WHEN 'mistral' THEN 'MISTRAL_API_KEY'
    WHEN 'moonshot' THEN 'MOONSHOT_API_KEY'
    WHEN 'qwen' THEN 'DASHSCOPE_API_KEY'
    WHEN 'zhipu' THEN 'ZHIPU_API_KEY'
    WHEN 'perplexity' THEN 'PERPLEXITY_API_KEY'
    ELSE 'DISABLED_MODEL_API_KEY'
  END,
  "enabled" = CASE
    WHEN "provider" IN ('openai','anthropic','google','groq','xai','deepseek','mistral','moonshot','qwen','zhipu','perplexity') THEN "enabled"
    ELSE FALSE
  END,
  "publiclyListed" = CASE
    WHEN "provider" IN ('openai','anthropic','google','groq','xai','deepseek','mistral','moonshot','qwen','zhipu','perplexity') THEN "publiclyListed"
    ELSE FALSE
  END,
  "status" = CASE
    WHEN "provider" IN ('openai','anthropic','google','groq','xai','deepseek','mistral','moonshot','qwen','zhipu','perplexity') THEN "status"
    ELSE 'disabled'
  END,
  "operationalReason" = CASE
    WHEN "provider" IN ('openai','anthropic','google','groq','xai','deepseek','mistral','moonshot','qwen','zhipu','perplexity') THEN "operationalReason"
    ELSE 'Unsupported provider disabled by the provider connection security migration.'
  END;

ALTER TABLE "ModelRegistryEntry"
ADD CONSTRAINT "ModelRegistryEntry_provider_connection_allowlist_check"
CHECK (
  ("provider" = 'openai' AND "apiBaseUrl" = 'https://api.openai.com/v1' AND "apiKeyEnvName" = 'OPENAI_API_KEY') OR
  ("provider" = 'anthropic' AND "apiBaseUrl" = 'https://api.anthropic.com' AND "apiKeyEnvName" = 'ANTHROPIC_API_KEY') OR
  ("provider" = 'google' AND "apiBaseUrl" = 'https://generativelanguage.googleapis.com/v1beta' AND "apiKeyEnvName" = 'GOOGLE_GENERATIVE_AI_API_KEY') OR
  ("provider" = 'groq' AND "apiBaseUrl" = 'https://api.groq.com/openai/v1' AND "apiKeyEnvName" = 'GROQ_API_KEY') OR
  ("provider" = 'xai' AND "apiBaseUrl" = 'https://api.x.ai/v1' AND "apiKeyEnvName" = 'XAI_API_KEY') OR
  ("provider" = 'deepseek' AND "apiBaseUrl" = 'https://api.deepseek.com' AND "apiKeyEnvName" = 'DEEPSEEK_API_KEY') OR
  ("provider" = 'mistral' AND "apiBaseUrl" = 'https://api.mistral.ai/v1' AND "apiKeyEnvName" = 'MISTRAL_API_KEY') OR
  ("provider" = 'moonshot' AND "apiBaseUrl" = 'https://api.moonshot.ai/v1' AND "apiKeyEnvName" = 'MOONSHOT_API_KEY') OR
  ("provider" = 'qwen' AND "apiBaseUrl" = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' AND "apiKeyEnvName" = 'DASHSCOPE_API_KEY') OR
  ("provider" = 'zhipu' AND "apiBaseUrl" = 'https://api.z.ai/api/paas/v4' AND "apiKeyEnvName" = 'ZHIPU_API_KEY') OR
  ("provider" = 'perplexity' AND "apiBaseUrl" = 'https://api.perplexity.ai' AND "apiKeyEnvName" = 'PERPLEXITY_API_KEY') OR
  ("provider" NOT IN ('openai','anthropic','google','groq','xai','deepseek','mistral','moonshot','qwen','zhipu','perplexity') AND "apiBaseUrl" = 'https://invalid.invalid' AND "apiKeyEnvName" = 'DISABLED_MODEL_API_KEY' AND "enabled" = FALSE AND "publiclyListed" = FALSE)
);
