export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
import { z } from "zod";
import { ApiSecurityError } from "@/lib/apiSecurity";
import { CodeCloudError, createCodeCloudService } from "@/lib/codeCloudService";

/** The runner reads the bundle of the job it claimed. Bearer only, like /api/code/cloud/runner; reads no session. */
export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  const jobId = z.string().uuid().safeParse(new URL(request.url).searchParams.get("job"));
  if (!jobId.success) return Response.json({ error: "CODE_CLOUD_JOB_NOT_FOUND" }, { status: 404, headers });
  const authorization = request.headers.get("authorization");
  try {
    const bytes = await createCodeCloudService().readRunnerBundle(authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null,
      request.headers.get("x-tomverse-job-token"), jobId.data);
    return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Type": "application/x-git-bundle", "Content-Length": String(bytes.byteLength) } });
  } catch (error) {
    if (error instanceof CodeCloudError || error instanceof ApiSecurityError)
      return Response.json({ error: error.code }, { status: error.status, headers });
    return Response.json({ error: "CODE_CLOUD_UNAVAILABLE" }, { status: 503, headers });
  }
}
