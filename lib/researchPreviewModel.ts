import "server-only";

import { createGoogle } from "@ai-sdk/google";
import { getActiveAiModel } from "./activeAiModel";
import { PROVIDER_API_CONFIGURATION, resolveProviderApiKey } from "./modelRegistryShared";
import type { AiModel } from "./models";

/** A provider-internal continuation must not bypass the Research dispatch ledger. */
export const researchPreviewGoogleFetch: typeof fetch = async (url, init) => {
  if (typeof init?.body !== "string") throw new Error("RESEARCH_PROVIDER_REQUEST_UNAVAILABLE");
  const request = JSON.parse(init.body) as Record<string, unknown>;
  if ("continuationToken" in request) throw new Error("RESEARCH_PROVIDER_CONTINUATION_REFUSED");
  return fetch(url, init);
};

export function getResearchPreviewAiModel(model: AiModel) {
  if (model.provider !== "google") return getActiveAiModel(model);
  return createGoogle({ baseURL: PROVIDER_API_CONFIGURATION.google.baseUrl,
    apiKey: resolveProviderApiKey("google"), fetch: researchPreviewGoogleFetch })(model.apiModel);
}
