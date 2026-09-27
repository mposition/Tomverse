-- Allow Sail Research as a provider connection.
--
-- Sail Research is the background and flexible-work host in the ADR v2.1
-- provider pool. Registered dark. See section 14.11 of
-- .github/audits/multi-provider-routing-deployment-identity-design-2026-09-22.md.
--
-- The known-provider allowlist gains one (provider, base URL, key name)
-- triple, identical to PROVIDER_API_CONFIGURATION in
-- lib/modelRegistryShared.ts. The unknown-provider clause's NOT IN list also
-- gains 'sail'. That second change narrows a placeholder row that already
-- used provider = 'sail' and the disabled sentinel URL. This header does not
-- call the migration widening-only.
--
-- The triple is the OpenAI-compatible base. Sail also documents an Anthropic
-- Messages base on the same origin without /v1; that surface is beta and is
-- not this connection.
--
-- No row is written here and no catalogue model routes to Sail. Vertex AI
-- and Azure OpenAI are not in this constraint: their endpoints are regional
-- or per-resource, and this migration does not invent one.
--
-- If a row already carries provider = 'sail' under the unknown-provider
-- clause, re-adding the constraint fails and the deploy stops. Nothing is
-- rewritten to make it pass.
--
-- Rollback: re-run 20260923380000_allow_openrouter_provider_connection's body,
-- after confirming no row has provider = 'sail'.

ALTER TABLE "ModelRegistryEntry"
DROP CONSTRAINT "ModelRegistryEntry_provider_connection_allowlist_check";

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
  ("provider" = 'minimax' AND "apiBaseUrl" = 'https://api.minimax.io/anthropic/v1' AND "apiKeyEnvName" = 'MINIMAX_API_KEY') OR
  ("provider" = 'qwen' AND "apiBaseUrl" = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' AND "apiKeyEnvName" = 'DASHSCOPE_API_KEY') OR
  ("provider" = 'zhipu' AND "apiBaseUrl" = 'https://api.z.ai/api/paas/v4' AND "apiKeyEnvName" = 'ZHIPU_API_KEY') OR
  ("provider" = 'perplexity' AND "apiBaseUrl" = 'https://api.perplexity.ai' AND "apiKeyEnvName" = 'PERPLEXITY_API_KEY') OR
  ("provider" = 'deepinfra' AND "apiBaseUrl" = 'https://api.deepinfra.com/v1/openai' AND "apiKeyEnvName" = 'DEEPINFRA_API_KEY') OR
  ("provider" = 'together' AND "apiBaseUrl" = 'https://api.together.ai/v1' AND "apiKeyEnvName" = 'TOGETHER_API_KEY') OR
  ("provider" = 'openrouter' AND "apiBaseUrl" = 'https://openrouter.ai/api/v1' AND "apiKeyEnvName" = 'OPENROUTER_API_KEY') OR
  ("provider" = 'sail' AND "apiBaseUrl" = 'https://api.sailresearch.com/v1' AND "apiKeyEnvName" = 'SAIL_API_KEY') OR
  ("provider" NOT IN ('openai','anthropic','google','groq','xai','deepseek','mistral','moonshot','minimax','qwen','zhipu','perplexity','deepinfra','together','openrouter','sail') AND "apiBaseUrl" = 'https://invalid.invalid' AND "apiKeyEnvName" = 'DISABLED_MODEL_API_KEY' AND "enabled" = FALSE AND "publiclyListed" = FALSE)
);
