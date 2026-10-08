export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedText } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";
import { amuxV22OutcomeWriteEnabled, AMUX_V22_OUTCOME_WRITE_ENV,
  inspectAmuxV22OutcomeRequest } from
  "@/lib/amux/v22OutcomeObservationCore";
import { AmuxV22OutcomeRefusal, readAmuxV22OutcomeReceipt,
  recordAmuxV22Outcome } from "@/lib/amux/v22OutcomeObservationService";

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const json = (body: object, status = 200) =>
  NextResponse.json(body, { status, headers });
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function owner(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session) ||
      getAdminRole(session) !== "owner") return null;
  await assertRecentAdminAuthentication(session);
  await consumeApiRateLimit(request, session.user.id,
    "admin-amux-v22-outcome", { minute: 20, day: 200 });
  return session;
}

export async function GET(request: Request) {
  try {
    const session = await owner(request);
    if (!session) return json({ error: "not_found" }, 404);
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].sort().join("|") !== "requestId|taskId")
      return json({ error: "invalid_request" }, 400);
    const taskId = params.get("taskId");
    const requestId = params.get("requestId");
    if (!taskId || !ID.test(taskId) || !requestId || !UUID.test(requestId))
      return json({ error: "invalid_request" }, 400);
    const receipt = await readAmuxV22OutcomeReceipt(taskId, requestId);
    return receipt ? json(receipt) : json({ error: "not_found" }, 404);
  } catch (error) {
    if (isAdminReauthenticationError(error))
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers });
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security; }
    return json({ error: "outcome_receipt_unavailable" }, 503);
  }
}

export async function POST(request: Request) {
  let requestId: string | null = null;
  try {
    const session = await owner(request);
    if (!session) return json({ error: "not_found" }, 404);
    if (!hasValidMutationOrigin(request))
      return json({ error: "forbidden" }, 403);
    if (!amuxV22OutcomeWriteEnabled(process.env[AMUX_V22_OUTCOME_WRITE_ENV]))
      return json({ error: "outcome_write_disabled" }, 503);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") return json({ error: "content_type_refused" }, 415);
    let body: unknown;
    try { body = JSON.parse(await readLimitedText(request, 2048)); } catch {
      return json({ error: "invalid_request" }, 400);
    }
    const parsed = inspectAmuxV22OutcomeRequest(body);
    if (!parsed)
      return json({ error: "invalid_request" }, 400);
    requestId = parsed.requestId;
    const result = await recordAmuxV22Outcome({ session, request, body });
    return json(result, result.replay ? 200 : 201);
  } catch (error) {
    if (isAdminReauthenticationError(error))
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers });
    if (error instanceof AmuxV22OutcomeRefusal)
      return json({ error: error.code }, error.status);
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security; }
    // The transaction may have committed before an I/O error. Read back the
    // operator's requestId; never automatically submit a second observation.
    return json({ error: "outcome_unknown", requestId,
      retryWrite: false }, 503);
  }
}
