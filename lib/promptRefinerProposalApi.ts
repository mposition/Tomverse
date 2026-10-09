import "server-only";

import { ApiSecurityError, readLimitedJson } from "@/lib/apiSecurity";
import {
  bindPromptRefinerSuggestion,
  promptRefinerRequestSchema,
  promptRefinerResponseSchema,
  type PromptRefinerRequest,
} from "@/lib/promptRefinerSuggestion";

const headers = { "Cache-Control": "no-store" };
const MAX_REQUEST_BYTES = 128 * 1024;

type ProposalDependencies = {
  authenticatedUserId: () => Promise<string | null>;
  suggest: (request: PromptRefinerRequest) => Promise<unknown>;
};

/** The route owns availability; this boundary owns auth and exact request binding. */
export async function handlePromptRefinerProposal(
  request: Request,
  dependencies: ProposalDependencies
): Promise<Response> {
  let userId: string | null;
  try {
    userId = await dependencies.authenticatedUserId();
  } catch {
    return Response.json(
      { code: "PROMPT_REFINER_UNAVAILABLE" },
      { status: 503, headers }
    );
  }
  if (!userId) {
    return Response.json(
      { code: "AUTHENTICATION_REQUIRED" },
      { status: 401, headers }
    );
  }

  let input: PromptRefinerRequest;
  try {
    input = await readLimitedJson(
      request,
      MAX_REQUEST_BYTES,
      promptRefinerRequestSchema
    );
  } catch (error) {
    return Response.json(
      { code: "PROMPT_REFINER_INVALID_REQUEST" },
      {
        status: error instanceof ApiSecurityError && error.status === 413 ? 413 : 400,
        headers,
      }
    );
  }

  try {
    const response = promptRefinerResponseSchema.parse(
      await dependencies.suggest(input)
    );
    // A response for another request, an unchanged draft, or an extra field is
    // unusable even when the isolated adapter claims success.
    bindPromptRefinerSuggestion({
      request: input,
      response,
      currentPrompt: input.prompt,
    });
    return Response.json(response, { headers });
  } catch {
    return Response.json(
      { code: "PROMPT_REFINER_INVALID_PROPOSAL" },
      { status: 502, headers }
    );
  }
}
