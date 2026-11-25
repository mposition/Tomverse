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
    case "cohere":
      return { mark: "CO", className: "from-white to-emerald-50", image: "/model-icons/cohere.png" };
    case "bfl":
      // Black Forest Labs (FLUX). The monochrome mark from @lobehub/icons-static-png
      // 2.5.0 (MIT), light variant: the frame is near-white in both themes.
      return { mark: "BFL", className: "from-white to-zinc-100", image: "/model-icons/bfl.png" };
    case "ideogram":
      // https://ideogram.ai/favicon.svg?v=new-brand-20261020
      return { mark: "ID", className: "from-white to-zinc-100", image: "/model-icons/ideogram.svg" };
    case "byteplus":
      // Seedream's direct provider. Icon published on the official BytePlus ModelArk product page.
      // https://sf-bpcms.bytepluscdn.com/obj/byteplus-public-aiso/portal/assets/apple-touch-icon.png
      return { mark: "BP", className: "from-white to-sky-50", image: "/model-icons/byteplus.png" };
    case "recraft":
      // https://www.recraft.ai/apps/icon.png
      return { mark: "R", className: "from-white to-zinc-100", image: "/model-icons/recraft.png" };
    case "minimax":
      // MiniMax has no local image asset, so the letter mark needs a real
      // brand-colour surface. A near-white gradient makes the shared white
      // fallback text fail WCAG contrast on the public model catalogue.
      return {
        mark: "MM",
        className: "bg-red-700 from-red-600 to-red-800",
      };
    default:
      return { mark: provider.slice(0, 2).toUpperCase(), className: "from-zinc-500 to-zinc-700" };
  }
};
