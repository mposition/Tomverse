export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { ApiSecurityError } from "@/lib/apiSecurity";
import { CodeCloudError, createCodeCloudService } from "@/lib/codeCloudService";

/** The patch a completed cloud job produced, for the person to review and apply on their own computer. */
export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  if (request.headers.get("x-tomverse-code") !== "1") return Response.json({ error: "CODE_ORIGIN_FORBIDDEN" }, { status: 403, headers });
  const jobId = z.string().uuid().safeParse(new URL(request.url).searchParams.get("job"));
  if (!jobId.success) return Response.json({ error: "CODE_CLOUD_JOB_NOT_FOUND" }, { status: 404, headers });
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return Response.json({ error: "CODE_SIGN_IN_REQUIRED" }, { status: 401, headers });
    const patch = await createCodeCloudService().readPatch(session.user.id, jobId.data);
    return new Response(new Uint8Array(patch.bytes), { headers: { ...headers, "Content-Type": "text/x-diff; charset=utf-8",
      "Content-Length": String(patch.bytes.byteLength), "X-Tomverse-Patch-Sha256": patch.sha256, "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    if (error instanceof CodeCloudError || error instanceof ApiSecurityError)
      return Response.json({ error: error.code }, { status: error.status, headers });
    return Response.json({ error: "CODE_CLOUD_UNAVAILABLE" }, { status: 503, headers });
  }
}
