export const dynamic = "force-dynamic";

/**
 * Product Prompt Refiner proposals are not admitted yet.
 *
 * The only executable suggestion adapter is the loopback E2E fixture. A
 * rollout flag, an approved one-shot evaluation budget, or a successful
 * synthetic test cannot authorize a proposal on a real Chat request. Keep
 * this product boundary closed until a separately reviewed server-owned
 * quality/rollout gate and product adapter are connected here.
 */
export async function POST(): Promise<Response> {
  // Deliberately refuse before reading user text, authenticating a caller,
  // reserving cost, or reaching any provider. This route has no GET surface.
  return Response.json(
    { code: "PROMPT_REFINER_UNAVAILABLE" },
    { status: 503, headers: { "Cache-Control": "no-store" } }
  );
}
