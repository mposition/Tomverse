/** The name a Review provider is shown under, on the web and in the Desktop app. */
const names: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google", xai: "xAI", deepseek: "DeepSeek", meta: "Meta", mistral: "Mistral", perplexity: "Perplexity", qwen: "Qwen", fal: "fal", bfl: "Black Forest Labs" };
export const reviewProviderName = (provider: string) => names[provider] ?? provider;
