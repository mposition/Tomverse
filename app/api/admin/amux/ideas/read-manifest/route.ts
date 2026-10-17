export const dynamic = "force-dynamic";

import type { Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from
  "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { readAmuxTrackedCheckoutReadManifestForOwner } from
  "@/lib/amux/ideaTrackedCheckoutReadManifestStore";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Decrypt paths only for their owner, on demand, while the absolute retention
 * window (or an active legal hold) still permits reading them. */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v19-read-manifest", { minute: 10, day: 100 });
    const params = new URL(request.url).searchParams;
    const ideaId = params.get("ideaId");
    const ordinalText = params.get("referenceOrdinal");
    if (params.size !== 2 || params.getAll("ideaId").length !== 1 ||
        params.getAll("referenceOrdinal").length !== 1 ||
        !ideaId || !UUID.test(ideaId) ||
        !/^(0|[1-9][0-9]*)$/.test(ordinalText ?? "")) {
      return NextResponse.json({ error: "schema_rejected" },
        { status: 400, headers: noStore });
    }
    const referenceOrdinal = Number(ordinalText);
    if (!Number.isSafeInteger(referenceOrdinal) ||
        referenceOrdinal > 2_147_483_647) {
      return NextResponse.json({ error: "schema_rejected" },
        { status: 400, headers: noStore });
    }
    const manifest = await readAmuxTrackedCheckoutReadManifestForOwner(
      session.user!.id!, ideaId, referenceOrdinal);
    if (!manifest) return NextResponse.json({ error: "not_found" },
      { status: 404, headers: noStore });
    return NextResponse.json({ manifest }, { headers: noStore });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", noStore["Cache-Control"]);
      return security;
    }
    console.error("AMUX v19 read manifest unavailable");
    return NextResponse.json({ error: "read_manifest_unavailable" },
      { status: 503, headers: noStore });
  }
}
