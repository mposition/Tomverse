export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { getAdminUsersPage, getFreshAdminUserStats } from "@/lib/adminUsers";
import { normalizeAdminUserSegment } from "@/lib/adminUserTypes";

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-users-search", {
      minute: 30,
      day: 500,
    });

    const url = new URL(req.url);
    const query = (url.searchParams.get("q") || "").trim().slice(0, 200);
    const cursor = (url.searchParams.get("cursor") || "").trim() || null;
    const segment = normalizeAdminUserSegment(url.searchParams.get("segment"));
    const includeStats = url.searchParams.get("includeStats") === "1";
    const requestedTake = Number(url.searchParams.get("take") || 20);
    const take = Number.isFinite(requestedTake)
      ? Math.min(Math.max(Math.trunc(requestedTake), 1), 50)
      : 20;

    const [page, stats] = await Promise.all([
      getAdminUsersPage({ query, cursor, segment, take }),
      includeStats ? getFreshAdminUserStats() : Promise.resolve(undefined),
    ]);

    return NextResponse.json(
      {
        ...page,
        ...(stats ? { stats } : {}),
      },
      {
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin user search failed:", error);
    return NextResponse.json(
      { error: "Failed to search users." },
      { status: 500 }
    );
  }
}
