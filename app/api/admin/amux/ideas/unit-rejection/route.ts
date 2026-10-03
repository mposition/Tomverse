export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedText } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AMUX_V4_UNIT_REJECT_READ_ENV,
  AMUX_V4_UNIT_REJECT_WRITE_ENV,
  AMUX_V4_UNIT_REJECT_BODY_MAX_BYTES,
  amuxV4UnitRejectReadPermitted,
  amuxV4UnitRejectWritePermitted,
  inspectAmuxUnitRejectRequest } from "@/lib/amux/ideaUnitRejectCore";
import { AmuxUnitRejectError, consumeAmuxUnitReject,
  prepareAmuxUnitReject, readAmuxUnitRejectDecision } from
  "@/lib/amux/ideaUnitRejectService";
import { boardImportContentTypeAccepted } from "@/lib/amux/boardImportCore";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

async function owner() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) {
    return { response: NextResponse.json({ error: "not_found" },
      { status: 404, headers: noStore }) } as const;
  }
  if (getAdminRole(session) !== "owner") {
    return { response: NextResponse.json({ error: "forbidden" },
      { status: 403, headers: noStore }) } as const;
  }
  try { await assertRecentAdminAuthentication(session); } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return { response: NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore }) } as const;
    }
    throw error;
  }
  return { session } as const;
}

function failure(error: unknown): Response {
  if (error instanceof AmuxUnitRejectError) {
    const status = error.code === "not_found" ? 404 : error.code === "reconfirm"
      ? 428 : error.code === "already_prepared" || error.code === "not_ready"
        ? 409 : 503;
    return NextResponse.json({ error: error.code }, { status, headers: noStore });
  }
  const security = apiSecurityResponse(error);
  if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
  console.error("AMUX v4 unit rejection unavailable");
  return NextResponse.json({ error: "integrity_unavailable" },
    { status: 503, headers: noStore });
}

/** Dark owner-only two-step rejection. No model call, card, node or promotion. */
export async function POST(request: Request): Promise<Response> {
  try {
    const auth = await owner();
    if ("response" in auth) return auth.response!;
    if (!amuxV4UnitRejectWritePermitted(process.env[AMUX_V4_UNIT_REJECT_WRITE_ENV])) {
      return NextResponse.json({ error: "write_disabled" },
        { status: 503, headers: noStore });
    }
    if (!boardImportContentTypeAccepted(request.headers.get("content-type"))) {
      return NextResponse.json({ error: "content_type_refused" },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, auth.session.user.id, "admin-amux-v4-unit-reject", {
      minute: 5, day: 50,
    });
    const choice = inspectAmuxUnitRejectRequest(await readLimitedText(request,
      AMUX_V4_UNIT_REJECT_BODY_MAX_BYTES));
    if (!choice) return NextResponse.json({ error: "schema_rejected" },
      { status: 400, headers: noStore });
    const result = choice.stage === "prepare"
      ? await prepareAmuxUnitReject(auth.session, request, choice)
      : await consumeAmuxUnitReject(auth.session, request, choice);
    return NextResponse.json(result, { status: choice.stage === "prepare" ? 201 : 200,
      headers: noStore });
  } catch (error) { return failure(error); }
}

/** Read-back remains separately gated so disabling writes need not hide an
 * uncertain outcome once the owner has explicitly enabled this capability. */
export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await owner();
    if ("response" in auth) return auth.response!;
    if (!amuxV4UnitRejectReadPermitted(process.env[AMUX_V4_UNIT_REJECT_READ_ENV])) {
      return NextResponse.json({ error: "read_disabled" },
        { status: 503, headers: noStore });
    }
    await consumeApiRateLimit(request, auth.session.user.id,
      "admin-amux-v4-unit-reject-read", { minute: 10, day: 100 });
    const query = new URL(request.url).searchParams;
    const decisionId = query.get("decisionId");
    const prepareRequestId = query.get("prepareRequestId");
    if (query.size !== 2 || !decisionId || !UUID.test(decisionId) ||
        !prepareRequestId || !UUID.test(prepareRequestId)) {
      return NextResponse.json({ error: "schema_rejected" },
        { status: 400, headers: noStore });
    }
    return NextResponse.json(await readAmuxUnitRejectDecision(auth.session,
      decisionId, prepareRequestId), { headers: noStore });
  } catch (error) { return failure(error); }
}
