import "server-only";

import type { ToolSet } from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
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
      // Deliberately unbuildable.
      //
      // `google.tools.googleSearch({})` takes no ceiling, on the tool or on the
      // request, so a request carrying it has no worst-case cost to reserve.
      // The Google models now search through the application-managed tool
      // instead (`lib/appManagedWebSearchTool.ts`), which has one, and
      // `nativeSearchIsDispatchable` already refuses this capability before any
      // caller gets here.
      //
      // Returning null rather than leaving the old builder in place, because
      // the two are not equivalent. A builder that *can* produce Google's
      // grounding is one `nativeSearchEnabled` computed slightly differently
      // away from sending it -- and sending it would both spend money nobody
      // authorized and, on Gemini, make the request mutually exclusive with the
      // function declarations that are now how this product searches. There is
      // no configuration of this application in which grounding is the right
      // answer, so there is no code path that emits it.
      return null;
    default:
      return null;
  }
};
