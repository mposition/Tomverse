-- Allow DeepInfra as a provider connection.
--
-- DeepInfra is the first inference host from the multi-provider routing ADR
-- v2.1 provider pool: it serves open-weight models (DeepSeek, Kimi, MiniMax)
-- on its own infrastructure, so a request sent there does not reach the model
-- developer. See section 14.4 of
-- .github/audits/multi-provider-routing-deployment-identity-design-2026-09-22.md.
--
-- Widening only. The allowlist gains one (provider, base URL, key name)
-- triple, identical to PROVIDER_API_CONFIGURATION in
-- lib/modelRegistryShared.ts, and 'deepinfra' joins the list the last clause
-- excludes -- without that, a deepinfra row would have to satisfy the
-- unknown-provider clause instead of its own.
--
-- No row is written here and no catalogue model routes to DeepInfra: a hosted
-- copy of a model is a ModelDeployment, not a registry row. The constraint is
-- re-added in full, as 20260803150000_allow_minimax_provider_connection did,
-- which validates the table; ModelRegistryEntry is small.
--
-- If a row already carries provider = 'deepinfra' under the unknown-provider
-- clause, re-adding the constraint fails and the deploy stops. That is the
-- intended direction: nothing is rewritten to make it pass.
--
-- Rollback: re-run 20260803150000_allow_minimax_provider_connection's body,
-- after confirming no row has provider = 'deepinfra'.

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
  ("provider" NOT IN ('openai','anthropic','google','groq','xai','deepseek','mistral','moonshot','minimax','qwen','zhipu','perplexity','deepinfra') AND "apiBaseUrl" = 'https://invalid.invalid' AND "apiKeyEnvName" = 'DISABLED_MODEL_API_KEY' AND "enabled" = FALSE AND "publiclyListed" = FALSE)
);
