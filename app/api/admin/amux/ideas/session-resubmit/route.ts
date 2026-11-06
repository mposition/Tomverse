export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AmuxIdeaResubmitError,
  resubmitAmuxSessionIdeaForOwner } from "@/lib/amux/ideaSessionResubmitService";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const body = z.object({ ideaId: z.string().uuid() }).strict();
const STATUS = { resubmitted: 200, not_found: 404, not_resubmittable: 409,
  raw_purged: 409, refused: 409, outcome_unknown: 503 } as const;

/** The owner submits a session idea again with its kept text and references
 * after its analysis ended with no plan, then the old idea is closed. A lost
 * answer is read back by the same click: the request id is the old idea's. */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner" || !hasValidMutationOrigin(request)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403, headers: noStore });
    }
    await assertRecentAdminAuthentication(session);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") {
      return NextResponse.json({ error: "content_type_refused" },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-idea-resubmit-write", { minute: 3, day: 20 });
    const parsed = await readLimitedJson(request, 512, body);
    const outcome = await resubmitAmuxSessionIdeaForOwner({ session, request,
      ideaId: parsed.ideaId });
    return NextResponse.json(outcome, { status: STATUS[outcome.result], headers: noStore });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    if (error instanceof AmuxIdeaResubmitError) {
      return NextResponse.json({ error: error.code },
        { status: error.code === "forbidden" ? 403 : 503, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", noStore["Cache-Control"]);
      return security;
    }
    return NextResponse.json({ result: "outcome_unknown" }, { status: 503, headers: noStore });
  }
}
