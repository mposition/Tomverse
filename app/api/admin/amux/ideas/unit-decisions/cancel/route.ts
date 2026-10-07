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
import { AMUX_V4_UNIT_WRITE_ENV, AmuxV4UnitDecisionError,
  amuxV4UnitWriteEnabled, cancelAmuxV4UnitDecision } from
  "@/lib/amux/ideaUnitDecisionStore";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const body = z.object({ decisionId: z.string()
  .regex(/^[A-Za-z0-9_-]{8,80}$/) }).strict();

/** A lost response is read back; only a still-prepared decision can be
 * explicitly closed. Cancellation never deletes a registered card. */
export async function POST(request: Request) {
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
    if (!amuxV4UnitWriteEnabled(process.env[AMUX_V4_UNIT_WRITE_ENV])) {
      return NextResponse.json({ error: "unit_write_disabled", retryWrite: false },
        { status: 503, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") {
      return NextResponse.json({ error: "content_type_refused", retryWrite: false },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-v4-unit-cancel", { minute: 3, day: 30 });
    let raw: unknown;
    try { raw = JSON.parse(await readLimitedText(request, 512)); }
    catch { return NextResponse.json({ error: "schema_rejected", retryWrite: false },
      { status: 400, headers: noStore }); }
    const parsed = body.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: "schema_rejected",
      retryWrite: false }, { status: 400, headers: noStore });
    const result = await cancelAmuxV4UnitDecision({ session, request,
      decisionId: parsed.data.decisionId });
    return NextResponse.json(result, { headers: noStore });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED",
        retryWrite: false }, { status: 428, headers: noStore });
    }
    if (error instanceof AmuxV4UnitDecisionError) {
      return NextResponse.json({ error: error.code, retryWrite: false },
        { status: error.code === "not_found" ? 404 :
          error.code === "reconfirm" ? 409 : 503, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", noStore["Cache-Control"]);
      return security;
    }
    return NextResponse.json({ error: "cancel_unavailable", retryWrite: false },
      { status: 503, headers: noStore });
  }
}
