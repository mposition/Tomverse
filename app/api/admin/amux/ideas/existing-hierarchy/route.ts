export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { loadAmuxExistingHierarchyTargets } from "@/lib/amux/ideaNodeDuplicateScanService";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

/** The existing active Initiative / Epic / Feature nodes with their titles,
 * so the plan approval screen names what a proposal attaches to (owner
 * decision 2026-11-22). Owner only, read-only. */
export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner") {
      return NextResponse.json({ error: "forbidden" }, { status: 403, headers: noStore });
    }
    await assertRecentAdminAuthentication(session);
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-existing-hierarchy", { minute: 20, day: 400 });
    const nodes = await loadAmuxExistingHierarchyTargets();
    return NextResponse.json({ nodes: nodes.map((node) => ({ ref: node.ref,
      level: node.level, title: node.title, displayPrefix: node.displayPrefix ?? null })) },
    { headers: noStore });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    return NextResponse.json({ error: "hierarchy_unavailable" }, { status: 503, headers: noStore });
  }
}
