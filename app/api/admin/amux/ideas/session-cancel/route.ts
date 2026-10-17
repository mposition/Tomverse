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
import { AmuxIdeaSessionCancellationError,
  commitAmuxIdeaSessionCancellation,
  readAmuxIdeaSessionCancellationReceipt } from
  "@/lib/amux/ideaSessionCancellationService";
import { prisma } from "@/lib/prisma";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const ideaId = z.string().uuid();
const body = z.object({ ideaId, ownerConfirmed: z.literal(true) }).strict();

async function owner() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) return null;
  if (getAdminRole(session) !== "owner") return "forbidden" as const;
  await assertRecentAdminAuthentication(session);
  return session;
}

function failure(error: unknown): Response {
  if (isAdminReauthenticationError(error)) {
    return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED",
      retryWrite: false }, { status: 428, headers: noStore });
  }
  if (error instanceof AmuxIdeaSessionCancellationError) {
    return NextResponse.json({ error: error.code, retryWrite: false },
      { status: error.code === "forbidden" ? 403 :
        error.code === "not_found" ? 404 :
        error.code === "not_cancellable" ? 409 : 503, headers: noStore });
  }
  const security = apiSecurityResponse(error);
  if (security) {
    security.headers.set("Cache-Control", noStore["Cache-Control"]);
    return security;
  }
  return NextResponse.json({ error: "outcome_unknown", retryWrite: false },
    { status: 503, headers: noStore });
}

/** An uncertain cancellation is reconciled by idea ID, never retried blind. */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (!session) return NextResponse.json({ error: "not_found" },
      { status: 404, headers: noStore });
    if (session === "forbidden") return NextResponse.json({ error: "forbidden" },
      { status: 403, headers: noStore });
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v19-session-cancel-read", { minute: 15, day: 100 });
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].length !== 1 || params.getAll("ideaId").length !== 1) {
      return NextResponse.json({ error: "schema_rejected" },
        { status: 400, headers: noStore });
    }
    const parsed = ideaId.safeParse(params.get("ideaId"));
    if (!parsed.success) return NextResponse.json({ error: "schema_rejected" },
      { status: 400, headers: noStore });
    const receipt = await prisma.$transaction((tx) =>
      readAmuxIdeaSessionCancellationReceipt(tx, session, parsed.data),
    { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json(receipt, { headers: noStore });
  } catch (error) { return failure(error); }
}

/** Owner-only pre-analysis queue cancellation. The intake bearer cannot call
 * this route, and a switched-off intake can still be cancelled safely. */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (!session) return NextResponse.json({ error: "not_found", retryWrite: false },
      { status: 404, headers: noStore });
    if (session === "forbidden" || !hasValidMutationOrigin(request)) {
      return NextResponse.json({ error: "forbidden", retryWrite: false },
        { status: 403, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") {
      return NextResponse.json({ error: "content_type_refused", retryWrite: false },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v19-session-cancel-write", { minute: 3, day: 20 });
    const parsed = await readLimitedJson(request, 512, body);
    const receipt = await prisma.$transaction((tx) =>
      commitAmuxIdeaSessionCancellation(tx, { ...parsed, session, request }),
    { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json({ state: "cancelled", ...receipt, retryWrite: false },
      { status: 201, headers: noStore });
  } catch (error) { return failure(error); }
}
