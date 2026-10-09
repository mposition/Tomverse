export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { isE2EFixtureMode } from "@/lib/e2eTestMode";
import {
  promptRefinerAvailable,
  promptRefinerKillSwitchEngaged,
  promptRefinerOfferDecision,
} from "@/lib/promptRefinerAccess";
import {
  PROMPT_REFINER_INPUT_SCOPE,
  PROMPT_REFINER_VERSION,
  type PromptRefinerRequest,
} from "@/lib/promptRefinerSuggestion";

const headers = { "Cache-Control": "no-store" };

const fixtureProposal = async (request: PromptRefinerRequest) => {
  const primary =
    "목표, 제약 조건, 원하는 출력 형식을 명확히 반영해 요청을 다시 작성해 주세요.";
  return {
    requestId: request.requestId,
    suggestionId: `fixture_${randomUUID().replaceAll("-", "")}`,
    refinedPrompt:
      request.prompt.trim() === primary
        ? "요청의 목표와 제약 조건, 원하는 결과 형식을 분명하게 정리해 주세요."
        : primary,
    refinerVersion: PROMPT_REFINER_VERSION,
    inputScope: PROMPT_REFINER_INPUT_SCOPE,
  };
};

/**
 * Product Prompt Refiner proposals are not admitted yet.
 *
 * The only executable suggestion adapter is the loopback E2E fixture. A
 * rollout flag, an approved one-shot evaluation budget, or a successful
 * synthetic test cannot authorize a proposal on a real Chat request. Keep
 * this product boundary closed until a separately reviewed server-owned
 * quality/rollout gate and product adapter are connected here.
 */
export async function POST(request: Request): Promise<Response> {
  // Product traffic never reads cookies, text or reaches an adapter here.
  if (
    !isE2EFixtureMode() ||
    promptRefinerKillSwitchEngaged(process.env)
  ) {
    return Response.json(
      { code: "PROMPT_REFINER_UNAVAILABLE" },
      { status: 503, headers }
    );
  }

  const { cookies } = await import("next/headers");
  const jar = await cookies();
  const fixtureAdapterReady =
    jar.get("__tomverse_e2e_prompt_refiner")?.value === "1";
  // Use the same cookie, rollout semantics and adapter decision as the shell.
  if (!promptRefinerOfferDecision({
    available: promptRefinerAvailable({
      storedFlagValue: fixtureAdapterReady ? "true" : undefined,
      env: process.env,
    }),
    adapterReady: fixtureAdapterReady,
  })) {
    return Response.json(
      { code: "PROMPT_REFINER_UNAVAILABLE" },
      { status: 503, headers }
    );
  }

  const { handlePromptRefinerProposal } =
    await import("@/lib/promptRefinerProposalApi");
  return handlePromptRefinerProposal(request, {
    // The layout's synthetic identity is valid only inside the full E2E gate.
    // There is no product authentication or provider mode behind this branch.
    authenticatedUserId: async () =>
      jar.get("__tomverse_e2e_auth")?.value === "1" ? "qa-user" : null,
    suggest: fixtureProposal,
  });
}
