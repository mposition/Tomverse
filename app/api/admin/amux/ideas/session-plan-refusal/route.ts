export const dynamic = "force-dynamic";

import type { Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from
  "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from
  "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { BoardImportError } from "@/lib/amux/boardImportCore";
import { decideAmuxPlanRefusalAsOwner } from
  "@/lib/amux/ideaSessionPlanRefusalOwnerService";
import { readOpenAmuxPlanRefusal } from "@/lib/amux/ideaSessionPlanRefusalService";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const ideaId = z.string().uuid();
const bodySchema = z.object({ ideaId, refusalId: z.string().uuid(),
  decision: z.enum(["retry", "stop"]) }).strict();

async function owner(): Promise<Session | NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
  }
  if (getAdminRole(session) !== "owner") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403, headers: noStore });
  }
  try { await assertRecentAdminAuthentication(session); } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    throw error;
  }
  return session;
}

const failure = (error: unknown) => {
  if (error instanceof BoardImportError) return NextResponse.json(
    { error: error.code }, { status: error.httpStatus, headers: noStore });
  const security = apiSecurityResponse(error);
  if (security) return security;
  throw error;
};

/** The refused answer an idea is waiting on: closed words only. */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    const id = ideaId.safeParse(new URL(request.url).searchParams.get("ideaId"));
    if (!id.success) return NextResponse.json({ error: "schema_rejected" },
      { status: 400, headers: noStore });
    return NextResponse.json({ refusal: await readOpenAmuxPlanRefusal(id.data) },
      { headers: noStore });
  } catch (error) { return failure(error); }
}

/** The owner decides without the Decision Maker. */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v19-plan-refusal", { minute: 5, day: 50 });
    const body = await readLimitedJson(request, 1_024, bodySchema);
    return NextResponse.json(await decideAmuxPlanRefusalAsOwner({ session,
      request, ...body }), { headers: noStore });
  } catch (error) { return failure(error); }
}
