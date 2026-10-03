export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedText } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { boardImportContentTypeAccepted } from "@/lib/amux/boardImportCore";
import { AMUX_V4_NODE_CREATE_READ_ENV, AMUX_V4_NODE_CREATE_WRITE_ENV,
  AMUX_V4_NODE_CREATE_BODY_MAX_BYTES,
  amuxV4NodeCreateReadPermitted, amuxV4NodeCreateWritePermitted,
  amuxRootNodeErrorBody, amuxRootNodeErrorStatus,
  inspectAmuxRootNodeRequest } from "@/lib/amux/ideaNodeCreateCore";
import { AmuxNodeCreateError } from "@/lib/amux/ideaNodeCreateService";
import { prepareAmuxRootNode, consumeAmuxRootNode,
  confirmAmuxRootNodeNoCommit } from
  "@/lib/amux/ideaNodeDecisionService";
import { readAmuxRootNodeDecision,
  AmuxNodeDecisionReadError } from "@/lib/amux/ideaNodeDecisionReadService";

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

function failure(error: unknown,
  recovery?: { decisionId: string; prepareRequestId: string }): Response {
  if (error instanceof AmuxNodeCreateError) {
    return NextResponse.json(amuxRootNodeErrorBody(error.code, recovery),
      { status: amuxRootNodeErrorStatus(error.code), headers: noStore });
  }
  if (error instanceof AmuxNodeDecisionReadError) {
    return NextResponse.json({ error: error.code },
      { status: amuxRootNodeErrorStatus(error.code), headers: noStore });
  }
  const security = apiSecurityResponse(error);
  if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
  console.error("AMUX v4 root node decision unavailable");
  return NextResponse.json({ error: "integrity_unavailable" },
    { status: 503, headers: noStore });
}

/** Dark, owner-only root Initiative decision. It never calls a model or
 * promotes a card. Both code latches remain closed until separate activation. */
export async function POST(request: Request): Promise<Response> {
  let recovery: { decisionId: string; prepareRequestId: string } | undefined;
  try {
    const auth = await owner();
    if ("response" in auth) return auth.response!;
    if (!amuxV4NodeCreateWritePermitted(process.env[AMUX_V4_NODE_CREATE_WRITE_ENV])) {
      return NextResponse.json({ error: "write_disabled" },
        { status: 503, headers: noStore });
    }
    if (!amuxV4NodeCreateReadPermitted(process.env[AMUX_V4_NODE_CREATE_READ_ENV])) {
      return NextResponse.json({ error: "read_disabled" },
        { status: 503, headers: noStore });
    }
    if (!boardImportContentTypeAccepted(request.headers.get("content-type"))) {
      return NextResponse.json({ error: "content_type_refused" },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, auth.session.user.id,
      "admin-amux-v4-root-node", { minute: 5, day: 50 });
    const choice = inspectAmuxRootNodeRequest(await readLimitedText(request,
      AMUX_V4_NODE_CREATE_BODY_MAX_BYTES));
    if (!choice) return NextResponse.json({ error: "schema_rejected" },
      { status: 400, headers: noStore });
    recovery = { decisionId: choice.decisionId,
      prepareRequestId: choice.prepareRequestId };
    const result = choice.stage === "prepare"
      ? await prepareAmuxRootNode(auth.session, request, choice)
      : choice.stage === "consume"
        ? await consumeAmuxRootNode(auth.session, request, choice)
        : await confirmAmuxRootNodeNoCommit(auth.session, request,
          choice.decisionId, choice.prepareRequestId);
    return NextResponse.json(result,
      { status: choice.stage === "prepare" ? 201 : 200, headers: noStore });
  } catch (error) { return failure(error, recovery); }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await owner();
    if ("response" in auth) return auth.response!;
    if (!amuxV4NodeCreateReadPermitted(process.env[AMUX_V4_NODE_CREATE_READ_ENV])) {
      return NextResponse.json({ error: "read_disabled" },
        { status: 503, headers: noStore });
    }
    await consumeApiRateLimit(request, auth.session.user.id,
      "admin-amux-v4-root-node-read", { minute: 10, day: 100 });
    const query = new URL(request.url).searchParams;
    const decisionId = query.get("decisionId");
    const prepareRequestId = query.get("prepareRequestId");
    if (query.size !== 2 || !decisionId || !UUID.test(decisionId) ||
        !prepareRequestId || !UUID.test(prepareRequestId)) {
      return NextResponse.json({ error: "schema_rejected" },
        { status: 400, headers: noStore });
    }
    return NextResponse.json(await readAmuxRootNodeDecision(auth.session,
      decisionId, prepareRequestId), { headers: noStore });
  } catch (error) { return failure(error); }
}
