export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedText } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AMUX_V4_UNIT_WRITE_ENV, AmuxV4DuplicateReasonRequired,
  AmuxV4UnitDecisionError,
  amuxV4UnitWriteEnabled } from "@/lib/amux/ideaUnitDecisionStore";
import { amuxV4UnitBrowserCookieName,
  newAmuxV4UnitBrowserNonce } from "@/lib/amux/ideaUnitBrowserCore";
import { prepareAmuxV4StoryRegistration } from
  "@/lib/amux/ideaStoryRegistrationService";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const body = z.object({ ideaId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
  draftUnitId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
  featureNodeId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
  prepareRequestId: z.uuid().regex(/^[a-f0-9-]+$/),
  cardType: z.enum(["story", "task"]).optional(),
  publicPrDisclosureApproved: z.boolean().optional().default(false),
  decisionReason: z.string().min(3).max(500).nullable() }).strict();

/** One owner-confirmed Story or Task; the shared write latch remains dark. */
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "not_found" },
        { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner") {
      return NextResponse.json({ error: "forbidden" },
        { status: 403, headers: noStore });
    }
    if (!hasValidMutationOrigin(request)) {
      return NextResponse.json({ error: "origin_refused" },
        { status: 403, headers: noStore });
    }
    await assertRecentAdminAuthentication(session);
    if (!amuxV4UnitWriteEnabled(process.env[AMUX_V4_UNIT_WRITE_ENV])) {
      return NextResponse.json({ error: "unit_write_disabled" },
        { status: 503, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") {
      return NextResponse.json({ error: "content_type_refused" },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-v4-unit-prepare", { minute: 3, day: 30 });
    let raw: unknown;
    try { raw = JSON.parse(await readLimitedText(request, 2_048)); }
    catch { return NextResponse.json({ error: "schema_rejected" },
      { status: 400, headers: noStore }); }
    const parsed = body.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: "schema_rejected" },
      { status: 400, headers: noStore });
    const browserNonce = newAmuxV4UnitBrowserNonce();
    const result = await prepareAmuxV4StoryRegistration({ session, request,
      choice: parsed.data, browserNonce });
    const response = NextResponse.json({ state: "prepared", ...result,
      retryWrite: false }, { status: 201, headers: noStore });
    response.cookies.set(amuxV4UnitBrowserCookieName(result.decisionId),
      browserNonce, { httpOnly: true, secure: true, sameSite: "strict",
        path: "/api/admin/amux/ideas", maxAge: 15 * 60 });
    return response;
  } catch (error) {
    if (error instanceof AmuxV4DuplicateReasonRequired) {
      return NextResponse.json({ error: error.code,
        candidateIds: error.candidateIds, retryWrite: false },
      { status: 409, headers: noStore });
    }
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    if (error instanceof AmuxV4UnitDecisionError) {
      return NextResponse.json({ error: error.code, retryWrite: false },
        { status: error.code === "not_found" ? 404 :
          error.code === "not_ready" || error.code === "reconfirm" ? 409 : 503,
          headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    return NextResponse.json({ error: "prepare_unavailable", retryWrite: false },
      { status: 503, headers: noStore });
  }
}
