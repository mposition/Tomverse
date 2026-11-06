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
import { AmuxIdeaCardCloseOwnerError, answerAmuxIdeaCardCloseForOwner,
  closeAmuxIdeaCardsDirectlyForOwner } from "@/lib/amux/ideaCardCloseOwnerService";
import { readAmuxIdeaCardCloseOwnerState } from "@/lib/amux/ideaCardCloseService";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const ideaId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
const answer = z.object({
  ideaId,
  questionId: z.string().uuid(),
  decision: z.enum(["close", "keep"]),
  reason: z.string().max(500),
  ownerConfirmed: z.literal(true),
}).strict();
/** With no question open, the owner closes the remaining cards directly. */
const direct = z.object({
  ideaId,
  direct: z.literal(true),
  decision: z.literal("close"),
  reason: z.string().max(500),
  ownerConfirmed: z.literal(true),
}).strict();
const body = z.union([answer, direct]);

function failure(error: unknown): Response {
  if (isAdminReauthenticationError(error)) {
    return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED", retryWrite: false },
      { status: 428, headers: noStore });
  }
  if (error instanceof AmuxIdeaCardCloseOwnerError) {
    return NextResponse.json({ error: error.code, retryWrite: false },
      { status: error.code === "forbidden" ? 403 : error.code === "invalid" ? 400 :
        error.code === "busy" ? 409 : 503, headers: noStore });
  }
  const security = apiSecurityResponse(error);
  if (security) {
    security.headers.set("Cache-Control", noStore["Cache-Control"]);
    return security;
  }
  return NextResponse.json({ error: "outcome_unknown", retryWrite: false },
    { status: 503, headers: noStore });
}

/**
 * The open card close question of one of the owner's ideas, or with none open
 * what a direct close would close, or neither.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner") {
      return NextResponse.json({ error: "forbidden" }, { status: 403, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-idea-card-close-read", { minute: 30, day: 500 });
    const parsed = ideaId.safeParse(new URL(request.url).searchParams.get("ideaId"));
    if (!parsed.success) {
      return NextResponse.json({ error: "schema_rejected" }, { status: 400, headers: noStore });
    }
    const state = await readAmuxIdeaCardCloseOwnerState({ ideaId: parsed.data, actorUserId: session.user.id });
    return NextResponse.json(state, { headers: noStore });
  } catch (error) { return failure(error); }
}

/**
 * The owner closes or keeps a stalled idea's remaining cards, or closes them
 * directly with no question open. It answers what happened (closed, kept,
 * cancelled, not_open, not_found, not_closable); an unknown outcome
 * is read back from the idea, never resent blind.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "not_found", retryWrite: false }, { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner" || !hasValidMutationOrigin(request)) {
      return NextResponse.json({ error: "forbidden", retryWrite: false }, { status: 403, headers: noStore });
    }
    await assertRecentAdminAuthentication(session);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return NextResponse.json({ error: "content_type_refused", retryWrite: false },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-idea-card-close-write", { minute: 5, day: 50 });
    const parsed = await readLimitedJson(request, 2_048, body);
    const result = "direct" in parsed
      ? await closeAmuxIdeaCardsDirectlyForOwner({ session, request, ideaId: parsed.ideaId, reason: parsed.reason })
      : await answerAmuxIdeaCardCloseForOwner({ session, request, ideaId: parsed.ideaId,
        questionId: parsed.questionId, decision: parsed.decision, reason: parsed.reason });
    return NextResponse.json({ ...result, retryWrite: false }, { headers: noStore });
  } catch (error) { return failure(error); }
}
