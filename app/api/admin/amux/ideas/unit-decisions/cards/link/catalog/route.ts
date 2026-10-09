export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { readAmuxIdeaResolutionCatalog } from
  "@/lib/amux/ideaResolutionPreviewService";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "not_found" },
        { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner") {
      return NextResponse.json({ error: "forbidden" },
        { status: 403, headers: noStore });
    }
    await assertRecentAdminAuthentication(session);
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-v4-card-link-catalog", { minute: 10, day: 100 });
    const ideaId = new URL(request.url).searchParams.get("ideaId") ?? "";
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(ideaId)) {
      return NextResponse.json({ error: "schema_rejected" },
        { status: 400, headers: noStore });
    }
    const catalog = await readAmuxIdeaResolutionCatalog(session, ideaId);
    return NextResponse.json({ features: catalog.nodes.filter((node) =>
      node.level === "feature" && node.state === "active"),
    cards: catalog.cards.filter((card) => card.status !== "cancelled") },
    { headers: noStore });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    return NextResponse.json({ error: "catalog_unavailable" },
      { status: 503, headers: noStore });
  }
}
