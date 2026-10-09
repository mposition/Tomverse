export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedText } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AmuxIdeaDerivationError,
  previewAmuxV4Derivation } from "@/lib/amux/ideaDerivationService";
import { amuxDerivationPayloadSchema } from
  "@/lib/amux/ideaDerivationRouteSchema";
import { loadAmuxContentKeyRing } from "@/lib/amux/ideaKeyStore";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

export async function POST(request: Request) {
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
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") {
      return NextResponse.json({ error: "content_type_refused" },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-v4-derivation-preview", { minute: 4, day: 40 });
    let raw: unknown;
    try { raw = JSON.parse(await readLimitedText(request, 65_536)); }
    catch { return NextResponse.json({ error: "schema_rejected" },
      { status: 400, headers: noStore }); }
    const parsed = amuxDerivationPayloadSchema.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: "schema_rejected" },
      { status: 400, headers: noStore });
    const keys = await loadAmuxContentKeyRing(parsed.data.sourceUnitIds.map(
      (subjectId) => ({ ideaId: parsed.data.ideaId,
        purpose: "analysis_draft" as const, subjectId })));
    const preview = await previewAmuxV4Derivation(session, parsed.data, keys);
    return NextResponse.json({ confirmationDigest: preview.confirmationDigest,
      expiresAt: preview.expiresAt.toISOString(),
      sources: preview.sourceCommitments,
      targets: preview.targets.map((target) => ({ id: target.id,
        localRef: target.localRef, bodyDigest: target.bodyDigest })),
      retryWrite: false }, { headers: noStore });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    if (error instanceof AmuxIdeaDerivationError) {
      return NextResponse.json({ error: error.code, retryWrite: false },
        { status: error.code === "invalid_input" ? 400 :
          error.code === "not_found" ? 404 : 409, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    return NextResponse.json({ error: "derivation_preview_unavailable" },
      { status: 503, headers: noStore });
  }
}
