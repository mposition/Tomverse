-- Allow the fixed Cohere public hosted API connection used by Command A+.
-- This does not allow a caller- or database-controlled Cohere endpoint: the
-- only accepted triple is the same one compiled into modelRegistryShared.
-- Private/Vault deployments remain outside this pricing and credential
-- boundary. Existing rows are not rewritten to make the new check pass.

ALTER TABLE "ModelRegistryEntry"
DROP CONSTRAINT "ModelRegistryEntry_provider_connection_allowlist_check";

ALTER TABLE "ModelRegistryEntry"
ADD CONSTRAINT "ModelRegistryEntry_provider_connection_allowlist_check"
CHECK (
  ("provider" = 'openai' AND "apiBaseUrl" = 'https://api.openai.com/v1' AND "apiKeyEnvName" = 'OPENAI_API_KEY') OR
  ("provider" = 'anthropic' AND "apiBaseUrl" = 'https://api.anthropic.com' AND "apiKeyEnvName" = 'ANTHROPIC_API_KEY') OR
  ("provider" = 'cohere' AND "apiBaseUrl" = 'https://api.cohere.com/v2' AND "apiKeyEnvName" = 'COHERE_API_KEY') OR
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
  ("provider" NOT IN ('openai','anthropic','cohere','google','groq','xai','deepseek','mistral','moonshot','minimax','qwen','zhipu','perplexity','deepinfra','together','openrouter','sail') AND "apiBaseUrl" = 'https://invalid.invalid' AND "apiKeyEnvName" = 'DISABLED_MODEL_API_KEY' AND "enabled" = FALSE AND "publiclyListed" = FALSE)
);
