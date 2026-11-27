export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;
import { ApiSecurityError, readLimitedJson } from "@/lib/apiSecurity";
import { codeCloudRunnerRequestSchema } from "@/lib/codeCloudContract";
import { CodeCloudError, createCodeCloudService } from "@/lib/codeCloudService";

/**
 * The cloud runner service's channel (docs/ops/desktop-cloud-execution.md): claim a queued job, report progress, ask
 * for one model call of the job, finish it. Bearer only: `Authorization: Bearer <CODE_CLOUD_RUNNER_SECRET>` and, for
 * a job, `X-Tomverse-Job-Token` from the claim. It reads no session or cookie, which is the condition for its exemption
 * from the mutation Origin check (lib/requestOrigin.ts, tests/codeCloudBoundary.test.mjs).
 */
const bearer = (value: string | null) => (value?.startsWith("Bearer ") ? value.slice(7).trim() || null : null);

export async function POST(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    // A patch travels as base64 inside the finish body (at most 8 MiB of it); model prompts are under a megabyte.
    const body = await readLimitedJson(request, 9 * 1024 * 1024 + 512 * 1024, codeCloudRunnerRequestSchema);
    const result = await createCodeCloudService().handleRunner(bearer(request.headers.get("authorization")), request.headers.get("x-tomverse-job-token"), body);
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof CodeCloudError)
      return Response.json({ error: error.code, dispatchState: error.dispatchState, ...(error.billing ? { billing: error.billing } : {}) }, { status: error.status, headers });
    if (error instanceof ApiSecurityError) return Response.json({ error: error.code, dispatchState: "not_dispatched" }, { status: error.status, headers });
    // An error here may have come after a model call left: the runner treats it as unknown and never sends that call again.
    return Response.json({ error: "CODE_CLOUD_UNAVAILABLE", dispatchState: "dispatched" }, { status: 503, headers });
  }
}
