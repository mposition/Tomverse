import "server-only";

import { createGoogle } from "@ai-sdk/google";
import { getActiveAiModel } from "./activeAiModel";
import { PROVIDER_API_CONFIGURATION, resolveProviderApiKey } from "./modelRegistryShared";
import type { AiModel } from "./models";

/** Argon's constrained decoder can reject nested array maximum hints.
 * The original Zod report schema still validates every returned tool input. */
function omitArrayMaximumHints(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitArrayMaximumHints);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "maxItems")
    .map(([key, entry]) => [key, omitArrayMaximumHints(entry)]));
}

/** A provider-internal continuation must not bypass the Research dispatch ledger. */
export const researchPreviewGoogleFetch: typeof fetch = async (url, init) => {
  if (typeof init?.body !== "string") throw new Error("RESEARCH_PROVIDER_REQUEST_UNAVAILABLE");
  const request = JSON.parse(init.body) as Record<string, unknown>;
  if ("continuationToken" in request) throw new Error("RESEARCH_PROVIDER_CONTINUATION_REFUSED");
  const pathname = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
  if (/\/models\/gemini-4-argon:(?:generateContent|streamGenerateContent)$/.test(pathname) && Array.isArray(request.tools)) {
    for (const group of request.tools) {
      if (!group || !Array.isArray(group.functionDeclarations)) continue;
      for (const declaration of group.functionDeclarations) {
        if (declaration.name === "submit_research_report" && declaration.parametersJsonSchema) {
          declaration.parametersJsonSchema = omitArrayMaximumHints(declaration.parametersJsonSchema);
        }
      }
    }
    return fetch(url, { ...init, body: JSON.stringify(request) });
  }
  return fetch(url, init);
};

export function getResearchPreviewAiModel(model: AiModel) {
  if (model.provider !== "google") return getActiveAiModel(model);
  return createGoogle({ baseURL: PROVIDER_API_CONFIGURATION.google.baseUrl,
    apiKey: resolveProviderApiKey("google"), fetch: researchPreviewGoogleFetch })(model.apiModel);
}
