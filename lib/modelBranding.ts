import type { AiProvider } from "@/lib/models";

export type ModelBrand = {
  mark: string;
  className: string;
  image?: string;
};

export const getModelBrand = (provider: AiProvider | string): ModelBrand => {
  switch (provider) {
    case "openai":
      return { mark: "GPT", className: "from-white to-zinc-100", image: "/model-icons/chatgpt.png" };
    case "anthropic":
      return { mark: "AI", className: "from-white to-orange-50", image: "/model-icons/claude.png" };
    case "google":
      return { mark: "Gemini", className: "from-white to-sky-50", image: "/model-icons/gemini.png" };
    case "groq":
      return { mark: "Llama", className: "from-white to-blue-50", image: "/model-icons/llama.png" };
    case "deepseek":
      return { mark: "DS", className: "from-white to-blue-50", image: "/model-icons/deepseek.png" };
    case "mistral":
      return { mark: "M", className: "from-white to-orange-50", image: "/model-icons/mistral.png" };
    case "xai":
      return { mark: "Grok", className: "from-white to-zinc-100", image: "/model-icons/grok.png" };
    case "qwen":
      return { mark: "QW", className: "from-white to-indigo-50", image: "/model-icons/qwen.png" };
    case "perplexity":
      return { mark: "P", className: "from-white to-cyan-50", image: "/model-icons/perplexity.png" };
    case "zhipu":
      return { mark: "Z", className: "from-white to-zinc-100", image: "/model-icons/zhipu.png" };
    case "moonshot":
      return { mark: "KM", className: "from-white to-blue-50", image: "/model-icons/kimi.png" };
    default:
      return { mark: provider.slice(0, 2).toUpperCase(), className: "from-zinc-500 to-zinc-700" };
  }
};
