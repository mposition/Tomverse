import "server-only";

import type { ToolSet } from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import {
  ANTHROPIC_MAX_SEARCH_USES,
  type WebSearchCapability,
} from "@/lib/webSearchCapability";

// The provider-defined tool factories below (openai.tools.webSearch,
// anthropic.tools.webSearch_20250305, google.tools.googleSearch) are pure
// tool-descriptor builders -- they carry no baseURL/apiKey of their own, so
// using the package-level singleton here (rather than a per-request
// createOpenAI/createAnthropic/createGoogle instance) is safe: the actual
// HTTP call still goes out through the already-configured `activeModel`
// object streamText is called with in app/api/chat/route.ts.
export const WEB_SEARCH_TOOL_NAMES: Record<WebSearchCapability["provider"] & string, string> = {
  openai: "web_search",
  anthropic: "web_search",
  google: "google_search",
};

export type WebSearchToolConfig = {
  tools: ToolSet;
  toolChoice?: "required";
};

// Single function, no per-component switch statements scattered elsewhere.
export const buildWebSearchToolConfig = (
  capability: WebSearchCapability
): WebSearchToolConfig | null => {
  if (capability.support !== "native") return null;
  switch (capability.provider) {
    case "openai":
      return {
        // No ceiling on the tool itself: OpenAI's is a request-level
        // parameter, `max_tool_calls`, and it is sent through
        // `providerOptions.openai.maxToolCalls` by
        // `getModelGenerationSettings` -- see
        // `openAiNativeSearchToolCallCeiling`. It cannot be set here without
        // being lost: `attemptDispatchOptions` spreads this object over the
        // generation settings, so a `providerOptions` returned from here would
        // replace the one carrying `reasoningEffort`.
        tools: { web_search: openai.tools.webSearch({}) },
        // OpenAI is the only provider whose native tool can be forced to
        // execute -- "always" should mean always for the models that
        // support forcing it.
        toolChoice: "required",
      };
    case "anthropic":
      return {
        // The same constant the capability declares its ceiling from, so the
        // number the request enforces and the number the reservation is sized
        // on cannot drift apart.
        tools: {
          web_search: anthropic.tools.webSearch_20250305({
            maxUses: ANTHROPIC_MAX_SEARCH_USES,
          }),
        },
        // Anthropic's server tool has no documented tool_choice override;
        // Claude decides per-turn whether the question needs a search.
      };
    case "google":
      return {
        tools: { google_search: google.tools.googleSearch({}) },
        // Google's grounding tool is not forceable either, and unlike OpenAI's
        // it takes no per-request call ceiling, so `nativeSearchIsDispatchable`
        // keeps callers from ever asking for this configuration today. Kept
        // whole so the day a ceiling exists is a capability change and not a
        // rewrite.
      };
    default:
      return null;
  }
};
