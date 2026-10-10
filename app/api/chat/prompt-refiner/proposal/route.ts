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
import { PROMPT_REFINER_PRODUCT_TIMEOUT_MS } from
  "@/lib/promptRefinerProductContract";

const headers = { "Cache-Control": "no-store" };
const unavailable = () => Response.json(
  { code: "PROMPT_REFINER_UNAVAILABLE" },
  { status: 503, headers }
);

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
 * Fixture traffic keeps its isolated loopback path. Product traffic accepts
 * only scope/draft identifiers; the server captures the authoritative draft
 * and the product release store remains default-off without exact evidence.
 */
export async function POST(request: Request): Promise<Response> {
  const requestDeadline = { requestedAt: new Date(),
    deadlineAtMonotonicMs: performance.now() +
      PROMPT_REFINER_PRODUCT_TIMEOUT_MS };
  if (!isE2EFixtureMode()) {
    const [{ getServerSession }, { authOptions },
      { handlePromptRefinerProductProposal,
        promptRefinerProductApiErrorResponse },
      { hasValidMutationOrigin }] = await Promise.all([
      import("next-auth/next"),
      import("@/lib/auth"),
      import("@/lib/promptRefinerProductApi"),
      import("@/lib/requestOrigin"),
    ]);
    try {
      const session = await getServerSession(authOptions);
      if (!session?.user?.id) return Response.json({ code: "UNAUTHORIZED" },
        { status: 401, headers });
      if (!hasValidMutationOrigin(request)) {
        return Response.json({ code: "FORBIDDEN" },
          { status: 403, headers });
      }
      return await handlePromptRefinerProductProposal(request, session.user.id,
        requestDeadline);
    } catch (error) {
      return promptRefinerProductApiErrorResponse(error) ??
        Response.json({ code: "PROMPT_REFINER_FALLBACK_ORIGINAL",
          reason: "audit_unavailable" }, { status: 503, headers });
    }
  }
  if (promptRefinerKillSwitchEngaged(process.env)) {
    return unavailable();
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
    return unavailable();
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
