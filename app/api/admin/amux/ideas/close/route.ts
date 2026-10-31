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
import { AMUX_IDEA_OWNER_CLOSE_LIMIT } from "@/lib/amux/ideaOwnerCloseCore";
import { AmuxIdeaOwnerCloseError,
  closeAmuxIdeasForOwner } from "@/lib/amux/ideaOwnerCloseService";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const body = z.object({
  ideaIds: z.array(z.string().max(80)).min(1).max(AMUX_IDEA_OWNER_CLOSE_LIMIT),
  reason: z.string().max(500),
  ownerConfirmed: z.literal(true),
}).strict();

/** Owner-only close of ideas waiting for the owner. Each idea answers on its
 * own (closed, already_closed, not_closable, not_found, outcome_unknown); an
 * unknown outcome is read back from the idea list, never resent blind. */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "not_found", retryWrite: false },
        { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner" || !hasValidMutationOrigin(request)) {
      return NextResponse.json({ error: "forbidden", retryWrite: false },
        { status: 403, headers: noStore });
    }
    await assertRecentAdminAuthentication(session);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") {
      return NextResponse.json({ error: "content_type_refused", retryWrite: false },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-idea-close-write", { minute: 5, day: 50 });
    const parsed = await readLimitedJson(request, 4_096, body);
    const outcomes = await closeAmuxIdeasForOwner({ session, request,
      ideaIds: parsed.ideaIds, reason: parsed.reason });
    return NextResponse.json({ outcomes, retryWrite: false },
      { status: 200, headers: noStore });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED",
        retryWrite: false }, { status: 428, headers: noStore });
    }
    if (error instanceof AmuxIdeaOwnerCloseError) {
      return NextResponse.json({ error: error.code, retryWrite: false },
        { status: error.code === "forbidden" ? 403 :
          error.code === "invalid" ? 400 : 503, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", noStore["Cache-Control"]);
      return security;
    }
    return NextResponse.json({ error: "outcome_unknown", retryWrite: false },
      { status: 503, headers: noStore });
  }
}
