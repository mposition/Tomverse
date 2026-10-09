export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { consumeApiRateLimit, apiSecurityResponse } from "@/lib/apiSecurity";
import { decideAmuxV22ExternalAuthority } from
  "@/lib/amux/v22ExternalAuthorityCore";
import { readAmuxV22DeploymentOutcome } from
  "@/lib/amux/v22DeploymentReadback";
import { authOptions } from "@/lib/auth";

const json = (body: object, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "private, no-store, max-age=0" },
});

/** Readback cannot unhalt an attempt or grant deployment authority. */
export async function GET(request: Request): Promise<Response> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session) ||
      getAdminRole(session) !== "owner")
    return json({ error: "Not found." }, 404);
  if (!decideAmuxV22ExternalAuthority({ actor: "amux_app",
    action: "observe_deployment" }).allowed)
    return json({ status: "outcome_unknown", diagnostic_only: true }, 409);
  try {
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-v22-deployment-readback", { minute: 5, day: 50 });
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].sort().join(",") !==
          "commit_sha,deployment_id,environment" ||
        [...params.values()].some((value) => value.length > 120))
      return json({ error: "Invalid request." }, 400);
    const environment = params.get("environment");
    if (environment !== "staging" && environment !== "production")
      return json({ error: "Invalid request." }, 400);
    const result = await readAmuxV22DeploymentOutcome({
      deploymentId: params.get("deployment_id") ?? "",
      commitSha: params.get("commit_sha") ?? "",
      environment,
    });
    return json({ ...result, diagnostic_only: true },
      result.status === "confirmed" ? 200 : 409);
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) return security;
    return json({ status: "outcome_unknown", diagnostic_only: true }, 503);
  }
}
