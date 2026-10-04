import { isE2EFixtureMode } from "@/lib/e2eTestMode";
import {
  PROMPT_REFINER_INPUT_SCOPE,
  promptRefinerRequestSchema,
  promptRefinerResponseSchema,
} from "@/lib/promptRefinerSuggestion";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

/**
 * Deterministic no-cost response for the real ChatInput E2E path.
 *
 * It lives in a server-only, fixture-gated route so the fabricated response
 * and timing do not ship in the product client bundle. There is no provider,
 * billing or Router connection behind this endpoint.
 */
export async function POST(request: Request) {
  if (!isE2EFixtureMode()) {
    return new Response(null, { status: 404, headers });
  }

  const parsed = promptRefinerRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return Response.json({ error: "invalid_request" }, { status: 400, headers });
  }

  const primary =
    "목표, 제약 조건, 원하는 출력 형식을 명확히 반영해 요청을 다시 작성해 주세요.";
  const refinedPrompt =
    parsed.data.prompt.trim() === primary
      ? "요청의 목표와 제약 조건, 원하는 결과 형식을 분명하게 정리해 주세요."
      : primary;
  const response = promptRefinerResponseSchema.parse({
    requestId: parsed.data.requestId,
    suggestionId: `fixture_suggestion_${parsed.data.requestId}`,
    refinedPrompt,
    refinerVersion: "suggest-v1",
    inputScope: PROMPT_REFINER_INPUT_SCOPE,
  });

  return Response.json(response, { headers });
}
