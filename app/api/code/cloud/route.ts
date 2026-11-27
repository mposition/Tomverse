export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";
import { ApiSecurityError, readLimitedJson } from "@/lib/apiSecurity";
import { codeCloudRequestSchema } from "@/lib/codeCloudContract";
import { CodeCloudError, createCodeCloudService } from "@/lib/codeCloudService";

/**
 * Desktop cloud execution jobs (docs/ops/desktop-cloud-execution.md): create, read, cancel and list. Authenticated as a
 * web page is, like /api/code/managed: session cookie (Desktop's account settings session), same-origin Origin and
 * `X-Tomverse-Code: 1`. Off unless TOMVERSE_DESKTOP_CLOUD_EXECUTION_ENABLED and its prerequisites are on.
 */
export async function POST(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  if (request.headers.get("x-tomverse-code") !== "1" || !request.headers.get("origin") || !hasValidMutationOrigin(request))
    return Response.json({ error: "CODE_ORIGIN_FORBIDDEN" }, { status: 403, headers });
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return Response.json({ error: "CODE_SIGN_IN_REQUIRED" }, { status: 401, headers });
    const body = await readLimitedJson(request, 128 * 1024, codeCloudRequestSchema);
    return Response.json(await createCodeCloudService().handle(session.user.id, body), { headers });
  } catch (error) {
    if (error instanceof CodeCloudError || error instanceof ApiSecurityError)
      return Response.json({ error: error.code }, { status: error.status, headers });
    return Response.json({ error: "CODE_CLOUD_UNAVAILABLE" }, { status: 503, headers });
  }
}
