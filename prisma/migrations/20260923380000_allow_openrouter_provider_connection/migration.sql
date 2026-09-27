-- Allow OpenRouter as a provider connection.
--
-- OpenRouter is the emergency aggregator in the ADR v2.1 provider pool.
-- Registered dark, and additionally fail-closed: lib/modelRegistryShared.ts
-- refuses a call that has no recipient allowlist, and pins provider.only plus
-- allow_fallbacks false on any body that is sent. See section 14.6 of
-- .github/audits/multi-provider-routing-deployment-identity-design-2026-09-22.md.
--
-- Widening only. The allowlist gains one (provider, base URL, key name)
-- triple, identical to PROVIDER_API_CONFIGURATION in
-- lib/modelRegistryShared.ts, and 'openrouter' joins the list the last clause
-- excludes.
--
-- No row is written here and no catalogue model routes to OpenRouter.
--
-- If a row already carries provider = 'openrouter' under the unknown-provider
-- clause, re-adding the constraint fails and the deploy stops.
--
-- Rollback: re-run 20260923370000_allow_together_provider_connection's body,
-- after confirming no row has provider = 'openrouter'.

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
  ("provider" NOT IN ('openai','anthropic','google','groq','xai','deepseek','mistral','moonshot','minimax','qwen','zhipu','perplexity','deepinfra','together','openrouter') AND "apiBaseUrl" = 'https://invalid.invalid' AND "apiKeyEnvName" = 'DISABLED_MODEL_API_KEY' AND "enabled" = FALSE AND "publiclyListed" = FALSE)
);
