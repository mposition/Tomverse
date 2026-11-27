export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";
import { ApiSecurityError } from "@/lib/apiSecurity";
import { CODE_CLOUD_LIMITS } from "@/lib/codeCloudContract";
import { CodeCloudError, createCodeCloudService } from "@/lib/codeCloudService";

/**
 * The git bundle of a created cloud job: exactly the bytes and SHA-256 the job was created with, a git bundle header,
 * at most CODE_CLOUD_LIMITS.bundleMaxBytes. Same authentication as /api/code/cloud.
 */
export async function PUT(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  if (request.headers.get("x-tomverse-code") !== "1" || !request.headers.get("origin") || !hasValidMutationOrigin(request))
    return Response.json({ error: "CODE_ORIGIN_FORBIDDEN" }, { status: 403, headers });
  const jobId = z.string().uuid().safeParse(new URL(request.url).searchParams.get("job"));
  if (!jobId.success) return Response.json({ error: "CODE_CLOUD_JOB_NOT_FOUND" }, { status: 404, headers });
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/x-git-bundle")
    return Response.json({ error: "CODE_CLOUD_BUNDLE_INVALID" }, { status: 415, headers });
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > CODE_CLOUD_LIMITS.bundleMaxBytes)
    return Response.json({ error: "CODE_CLOUD_BUNDLE_TOO_LARGE" }, { status: 413, headers });
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return Response.json({ error: "CODE_SIGN_IN_REQUIRED" }, { status: 401, headers });
    return Response.json(await createCodeCloudService().uploadBundle(session.user.id, jobId.data, request.body), { headers });
  } catch (error) {
    if (error instanceof CodeCloudError || error instanceof ApiSecurityError)
      return Response.json({ error: error.code }, { status: error.status, headers });
    return Response.json({ error: "CODE_CLOUD_UNAVAILABLE" }, { status: 503, headers });
  }
}
