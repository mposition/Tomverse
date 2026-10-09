export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedText } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AmuxIdeaDerivationError, approveAmuxV4Derivation,
  previewAmuxV4Derivation } from "@/lib/amux/ideaDerivationService";
import { amuxDerivationApprovalSchema } from
  "@/lib/amux/ideaDerivationRouteSchema";
import { createAmuxContentKeyRing,
  loadAmuxContentKeyRing } from "@/lib/amux/ideaKeyStore";
import { AMUX_V4_UNIT_WRITE_ENV, amuxV4UnitWriteEnabled } from
  "@/lib/amux/ideaUnitDecisionStore";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

export async function POST(request: Request) {
  let requestId: string | null = null;
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "not_found" },
        { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner" || !hasValidMutationOrigin(request)) {
      return NextResponse.json({ error: "forbidden" },
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
      "admin-amux-v4-derivation-approve", { minute: 2, day: 20 });
    let raw: unknown;
    try { raw = JSON.parse(await readLimitedText(request, 65_536)); }
    catch { return NextResponse.json({ error: "schema_rejected" },
      { status: 400, headers: noStore }); }
    const parsed = amuxDerivationApprovalSchema.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: "schema_rejected" },
      { status: 400, headers: noStore });
    const payload = parsed.data.payload;
    requestId = payload.requestId;
    const existing = payload.sourceUnitIds.map((subjectId) => ({
      ideaId: payload.ideaId, purpose: "analysis_draft" as const, subjectId,
    }));
    const beforeKeys = await loadAmuxContentKeyRing(existing);
    const before = await previewAmuxV4Derivation(session, payload, beforeKeys);
    if (before.confirmationDigest !== parsed.data.confirmationDigest) {
      return NextResponse.json({ error: "reconfirm", retryWrite: false },
        { status: 409, headers: noStore });
    }
    const keys = await createAmuxContentKeyRing(existing,
      payload.targetUnitIds.map((subjectId) => ({ ideaId: payload.ideaId,
        purpose: "analysis_draft" as const, subjectId })));
    const result = await approveAmuxV4Derivation({ session, request,
      payload, confirmationDigest: parsed.data.confirmationDigest, keys });
    return NextResponse.json({ ...result, retryWrite: false },
      { status: result.state === "approved" ? 201 : 200, headers: noStore });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    if (error instanceof AmuxIdeaDerivationError) {
      return NextResponse.json({ error: error.code, retryWrite: false },
        { status: error.code === "invalid_input" ? 400 :
          error.code === "not_found" ? 404 :
          error.code === "write_disabled" ? 503 : 409, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    return NextResponse.json({ error: "outcome_unknown", requestId,
      retryWrite: false }, { status: 503, headers: noStore });
  }
}
