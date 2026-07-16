export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { getAllAdminUsersForExport } from "@/lib/adminUsers";
import { adminUsersCsv } from "@/lib/adminUsersCsv";
import { normalizeAdminUserSegment } from "@/lib/adminUserTypes";

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return Response.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-users-export", {
      minute: 5,
      day: 30,
    });

    const url = new URL(req.url);
    const query = (url.searchParams.get("q") || "").trim().slice(0, 200);
    const segment = normalizeAdminUserSegment(url.searchParams.get("segment"));
    const users = await getAllAdminUsersForExport({ query, segment });
    const stamp = new Date().toISOString().slice(0, 10);

    return new Response(adminUsersCsv(users), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="tomverse-users-${segment}-${stamp}.csv"`,
        "Cache-Control": "private, no-store, max-age=0",
      },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin full user export failed:", error);
    return Response.json(
      { error: "Failed to export users." },
      { status: 500 }
    );
  }
}
