export const dynamic = "force-dynamic";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeAmuxOperatingScope } from "@/lib/amux/ideaOperatingScopeCore";
import { AmuxOperatingScopeError, commitAmuxOperatingScope, readAmuxOperatingScope } from "@/lib/amux/ideaOperatingScopeStore";

// docs/policy/amux-intake.md v19 item 2: the owner's operating scope. Owner-only
// for reading too, because the allowlist may name private repositories. Saving
// a scope starts nothing; the session intake switch is separate (v19 item 9).
const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const schema = z.object({ id: z.string().uuid(),
  expectedPreviousVersion: z.number().int().nonnegative().max(2_147_483_646),
  scope: z.unknown(), ownerConfirmed: z.literal(true) }).strict();

async function owner() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) return null;
  if (getAdminRole(session) !== "owner") throw new AmuxOperatingScopeError("forbidden");
  await assertRecentAdminAuthentication(session);
  return session;
}

function failure(error: unknown) {
  if (isAdminReauthenticationError(error)) {
    return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" }, { status: 428, headers: noStore });
  }
  if (error instanceof AmuxOperatingScopeError) {
    return NextResponse.json({ error: error.code, retryWrite: false }, { status: error.code === "forbidden" ? 403
      : error.code === "scope_unavailable" ? 503 : error.code === "invalid_scope" ? 400 : 409, headers: noStore });
    // model_not_approved, revision_changed and request_already_seen are 409: the
    // request was well formed but the current state refuses it.
  }
  const security = apiSecurityResponse(error);
  if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
  // Unknown: the save may or may not have committed. Read it back by its ID.
  return NextResponse.json({ error: "outcome_unknown", retryWrite: false }, { status: 503, headers: noStore });
}

export async function GET(request: Request): Promise<Response> {
  try {
    if (!await owner()) return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((key) => key !== "id") || params.getAll("id").length > 1) {
      throw new AmuxOperatingScopeError("invalid_scope");
    }
    const id = params.get("id");
    if (id !== null) {
      if (!z.string().uuid().safeParse(id).success) throw new AmuxOperatingScopeError("invalid_scope");
      const saved = await prisma.amuxIdeaOperatingScopeSetting.findUnique({ where: { id } });
      if (!saved) return NextResponse.json({ state: "not_visible", retryWrite: false }, { headers: noStore });
      const admitted = normalizeAmuxOperatingScope({ repositories: saved.repositories, model: {
        provider: saved.modelProvider, modelId: saved.modelId, reasoningEffort: saved.reasoningEffort } });
      if (!admitted.ok) throw new AmuxOperatingScopeError("scope_unavailable");
      return NextResponse.json({ state: "saved", id: saved.id, version: saved.version,
        scope: admitted.scope, auditId: saved.approvalAuditLogId }, { headers: noStore });
    }
    const current = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('statement_timeout', '5000', true),
        set_config('idle_in_transaction_session_timeout', '10000', true)`;
      return readAmuxOperatingScope(tx);
    }, { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json(current ? { state: "current", ...current } : { state: "none", version: 0 },
      { headers: noStore });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (!session) return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return NextResponse.json({ error: "Invalid content type." }, { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-intake-operating-scope", { minute: 3, day: 20 });
    const body = await readLimitedJson(request, 16_384, schema);
    const saved = await prisma.$transaction((tx) => commitAmuxOperatingScope(tx, {
      session, request, id: body.id, expectedPreviousVersion: body.expectedPreviousVersion,
      scope: body.scope, ownerConfirmed: body.ownerConfirmed }), { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json({ state: "saved", ...saved }, { status: 201, headers: noStore });
  } catch (error) { return failure(error); }
}
