export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: "normal" | "error" | "cancelled";
  modelId?: string; // 💡 모델 ID 추가
};

export type Conversation = {
  id: string;
    title: string;
    selectedModels?: string[];
    disabledPanels?: string[];
    isLocked?: boolean; // 💡 잠금 여부 (백엔드에서 password 존재 여부로 true/false 반환)
};

export type AiProvider =
    | "openai"
    | "anthropic"
    | "google"
    | "groq"
    | "xai"
    | "deepseek"
    | "moonshot"
    | "minimax"
    | "zhipu"
    | "qwen"
    | "mistral"
    | "perplexity"
    | "cohere"
    | "bedrock";

export type ModelTier = "Free" | "Pro" | "Max";
export type ModelStatus = "enabled" | "disabled" | "coming-soon";

export type AiModel = {
    id: string;          // UI 내부 ID
    name: string;        // 표시 이름
    apiModel: string;    // 실제 API 모델 ID
    provider: AiProvider;
    icon: string;
    tier: ModelTier;
    status?: ModelStatus;
    reasoning?: "none" | "low" | "medium" | "high";
};

export const MAX_SELECTED_MODELS = 3;

export const AVAILABLE_MODELS: AiModel[] = [
    { id: "gpt-5-5", name: "GPT-5.5", apiModel: "gpt-5.5", provider: "openai", icon: "🤖", tier: "Max" },
    { id: "gpt-5-5-thinking", name: "GPT-5.5 Thinking", apiModel: "gpt-5.5", provider: "openai", icon: "🤖", tier: "Max", reasoning: "high" },
    { id: "gpt-5-4-mini", name: "GPT-5.4 mini", apiModel: "gpt-5.4-mini", provider: "openai", icon: "🤖", tier: "Pro" },

    { id: "claude-fable-5", name: "Claude Fable 5", apiModel: "claude-fable-5", provider: "anthropic", icon: "🧠", tier: "Max" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8", apiModel: "claude-opus-4-8", provider: "anthropic", icon: "🧠", tier: "Max" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", apiModel: "claude-sonnet-5", provider: "anthropic", icon: "🧠", tier: "Pro" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", apiModel: "claude-haiku-4-5-20251001", provider: "anthropic", icon: "🧠", tier: "Pro" },

    { id: "gemini-3-5-flash", name: "Gemini 3.5 Flash", apiModel: "gemini-3.5-flash", provider: "google", icon: "✨", tier: "Pro" },
    { id: "gemini-3-1-pro", name: "Gemini 3.1 Pro", apiModel: "gemini-3.1-pro", provider: "google", icon: "✨", tier: "Max" },
    { id: "gemini-2-5-pro", name: "Gemini 2.5 Pro", apiModel: "gemini-2.5-pro", provider: "google", icon: "✨", tier: "Pro" },
    { id: "gemini-2-5-flash", name: "Gemini 2.5 Flash", apiModel: "gemini-2.5-flash", provider: "google", icon: "✨", tier: "Free" },

    { id: "llama-4", name: "Llama 4", apiModel: "meta-llama/llama-4-scout-17b-16e-instruct", provider: "groq", icon: "L4", tier: "Pro" },

    { id: "grok-4-3", name: "Grok 4.3", apiModel: "grok-4-3", provider: "xai", icon: "𝕏", tier: "Max", status: "coming-soon" },
    { id: "deepseek-v4-pro", name: "DeepSeek-V4 Pro", apiModel: "deepseek-v4-pro", provider: "deepseek", icon: "DS", tier: "Pro", status: "coming-soon" },
    { id: "kimi-k2-7-code", name: "Kimi K2.7 Code", apiModel: "kimi-k2-7-code", provider: "moonshot", icon: "KM", tier: "Pro", status: "coming-soon" },
];