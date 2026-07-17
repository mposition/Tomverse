import type { AiProvider } from "@/lib/models";

export const AI_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "groq",
  "xai",
  "deepseek",
  "mistral",
  "moonshot",
  "qwen",
  "zhipu",
  "perplexity",
] as const satisfies readonly AiProvider[];

export const PROVIDER_API_CONFIGURATION: Record<
  AiProvider,
  { baseUrl: string; apiKeyEnvName: string; protocol: "native" | "openai-compatible" }
> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnvName: "OPENAI_API_KEY",
    protocol: "native",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    apiKeyEnvName: "ANTHROPIC_API_KEY",
    protocol: "native",
  },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnvName: "GOOGLE_GENERATIVE_AI_API_KEY",
    protocol: "native",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnvName: "GROQ_API_KEY",
    protocol: "openai-compatible",
  },
  xai: {
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnvName: "XAI_API_KEY",
    protocol: "openai-compatible",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    apiKeyEnvName: "DEEPSEEK_API_KEY",
    protocol: "openai-compatible",
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnvName: "MISTRAL_API_KEY",
    protocol: "openai-compatible",
  },
  moonshot: {
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnvName: "MOONSHOT_API_KEY",
    protocol: "openai-compatible",
  },
  qwen: {
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKeyEnvName: "DASHSCOPE_API_KEY",
    protocol: "openai-compatible",
  },
  zhipu: {
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnvName: "ZHIPU_API_KEY",
    protocol: "openai-compatible",
  },
  perplexity: {
    baseUrl: "https://api.perplexity.ai",
    apiKeyEnvName: "PERPLEXITY_API_KEY",
    protocol: "openai-compatible",
  },
};

export const isAiProvider = (value: string): value is AiProvider =>
  (AI_PROVIDERS as readonly string[]).includes(value);

export const normalizeApiBaseUrl = (value: string) => value.trim().replace(/\/$/, "");

export const isApprovedProviderApiBaseUrl = (
  provider: AiProvider,
  value: string | null | undefined
) =>
  normalizeApiBaseUrl(value || "") ===
  PROVIDER_API_CONFIGURATION[provider].baseUrl;

export const isApprovedProviderApiKeyEnvName = (
  provider: AiProvider,
  value: string | null | undefined
) => value === PROVIDER_API_CONFIGURATION[provider].apiKeyEnvName;

const isPrivateIpv4 = (hostname: string) => {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0
  );
};

export const isSafeProviderApiBaseUrl = (value: string) => {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (url.search || url.hash) return false;
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname === "::1" ||
      hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      hostname.startsWith("fe80:") ||
      isPrivateIpv4(hostname)
    ) {
      return false;
    }
    return Boolean(hostname.includes("."));
  } catch {
    return false;
  }
};
