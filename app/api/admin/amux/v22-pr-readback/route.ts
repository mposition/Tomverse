export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { consumeApiRateLimit, apiSecurityResponse } from "@/lib/apiSecurity";
import { decideAmuxV22ExternalAuthority } from
  "@/lib/amux/v22ExternalAuthorityCore";
import { readAmuxV22PrCreationOutcome } from
  "@/lib/amux/v22ExternalReadback";
import { authOptions } from "@/lib/auth";

const json = (body: object, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "private, no-store, max-age=0" },
});

/** Readback is diagnostic only: it never creates a PR or unhalts an attempt. */
export async function GET(request: Request): Promise<Response> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session) ||
      getAdminRole(session) !== "owner")
    return json({ error: "Not found." }, 404);
  if (!decideAmuxV22ExternalAuthority({ actor: "amux_app",
    action: "observe_pr" }).allowed)
    return json({ status: "outcome_unknown", diagnostic_only: true }, 409);
  try {
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-v22-pr-readback", { minute: 10, day: 100 });
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].sort().join(",") !== "base_sha,branch,head_sha" ||
        [...params.values()].some((value) => value.length > 120))
      return json({ error: "Invalid request." }, 400);
    const result = await readAmuxV22PrCreationOutcome({
      branch: params.get("branch") ?? "",
      baseSha: params.get("base_sha") ?? "",
      headSha: params.get("head_sha") ?? "",
    });
    return json({ ...result, diagnostic_only: true },
      result.status === "confirmed" ? 200 : 409);
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) return security;
    return json({ status: "outcome_unknown", diagnostic_only: true }, 503);
  }
}
