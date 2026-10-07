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
import { readAmuxV4UnitBrowserNonce } from
  "@/lib/amux/ideaUnitBrowserCore";
import { AMUX_V4_UNIT_WRITE_ENV, AmuxV4UnitDecisionError,
  amuxV4UnitWriteEnabled } from "@/lib/amux/ideaUnitDecisionStore";
import { consumeAmuxV4UnitRejection } from
  "@/lib/amux/ideaUnitRejectionService";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const body = z.object({ decisionId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
  consumeRequestId: z.uuid().regex(/^[a-f0-9-]+$/),
  confirmationDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "not_found", retryWrite: false },
        { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner") {
      return NextResponse.json({ error: "forbidden", retryWrite: false },
        { status: 403, headers: noStore });
    }
    if (!hasValidMutationOrigin(request)) {
      return NextResponse.json({ error: "origin_refused", retryWrite: false },
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
      "admin-amux-v4-reject-consume", { minute: 3, day: 30 });
    let raw: unknown;
    try { raw = JSON.parse(await readLimitedText(request, 1_024)); }
    catch { return NextResponse.json({ error: "schema_rejected", retryWrite: false },
      { status: 400, headers: noStore }); }
    const parsed = body.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: "schema_rejected",
      retryWrite: false }, { status: 400, headers: noStore });
    const browserNonce = readAmuxV4UnitBrowserNonce(request.headers.get("cookie"),
      parsed.data.decisionId);
    if (!browserNonce) return NextResponse.json({ error: "browser_mismatch",
      retryWrite: false }, { status: 409, headers: noStore });
    const result = await consumeAmuxV4UnitRejection({ session, request,
      ...parsed.data, browserNonce });
    return NextResponse.json({ state: "consumed", ...result,
      retryWrite: false }, { status: 201, headers: noStore });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED",
        retryWrite: false }, { status: 428, headers: noStore });
    }
    if (error instanceof AmuxV4UnitDecisionError) {
      return NextResponse.json({ error: error.code, retryWrite: false },
        { status: error.code === "not_found" ? 404 :
          error.code === "not_ready" || error.code === "reconfirm" ? 409 : 503,
          headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    return NextResponse.json({ error: "reject_consume_unavailable", retryWrite: false },
      { status: 503, headers: noStore });
  }
}
