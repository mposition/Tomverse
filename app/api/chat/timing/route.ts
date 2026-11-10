import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";
import { clientLatencyBodySchema } from "@/lib/responseLatencyCore";
import { verifyResponseLatencyToken } from "@/lib/responseLatencyToken";
import { recordResponseLatency } from "@/lib/responseLatencyStore";

export async function POST(request: Request) {
  // Browser-only diagnostics. No extension of native bearer permissions.
  if (!request.headers.get("origin") || !hasValidMutationOrigin(request)) return new Response(null, { status: 403 });
  try {
    const body = await readLimitedJson(request, 4_096, clientLatencyBodySchema);
    const proof = verifyResponseLatencyToken(body.token);
    if (!proof) return new Response(null, { status: 403 });
    await consumeApiRateLimit(request, proof.id, "response-latency", { minute: 6, day: 12 });
    await recordResponseLatency(`${proof.id}:client`, {
      product: proof.product, mode: proof.mode, modelId: null, provider: null,
      source: "client", outcome: body.outcome,
      timings: { ...body.stages, prepareMs: body.prepareMs, completionMs: body.completionMs,
        ...(body.firstContentMs === null ? {} : { firstContentMs: body.firstContentMs }) },
    });
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiSecurityResponse(error) ?? new Response(null, { status: 400 });
  }
}
