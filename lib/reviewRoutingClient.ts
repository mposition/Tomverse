import { AUTO_LLM_ROUTER_MAX_CONTEXT_CHARS, AUTO_LLM_ROUTER_MAX_PROMPT_CHARS } from "@/lib/autoLlmRouterCore";
import type { ReviewRouteDecision } from "@/lib/reviewRoutingCore";

export async function askReviewRoute(input: {
  text: string; providers: string[]; context?: string; hasImages: boolean;
  requestedKind?: "image";
  imageOnly?: boolean;
}, fetchImpl: typeof fetch = fetch): Promise<ReviewRouteDecision | { kind: "blocked"; reason: "image" } | null> {
  try {
    const response = await fetchImpl("/api/review/route", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, text: input.text.slice(0, AUTO_LLM_ROUTER_MAX_PROMPT_CHARS), ...(input.context ? { context: input.context.slice(0, AUTO_LLM_ROUTER_MAX_CONTEXT_CHARS) } : {}) }), signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      return response.status === 403 && error?.error === "IMAGE_UNAVAILABLE" ? { kind: "blocked", reason: "image" } : null;
    }
    const result = await response.json() as ReviewRouteDecision;
    if ((result.kind !== "text" && result.kind !== "image") ||
      !["draft", "standard", "final"].includes(result.preset) ||
      !Array.isArray(result.choices) || result.choices.length !== input.providers.length ||
      input.providers.some(provider => result.choices.filter(choice => choice?.provider === provider).length !== 1) ||
      result.choices.some(choice => choice.modelId !== null && typeof choice.modelId !== "string")) return null;
    return result;
  } catch { return null; }
}
