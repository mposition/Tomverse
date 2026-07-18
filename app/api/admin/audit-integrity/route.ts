export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { verifyAdminAuditIntegrity } from "@/lib/adminAuditIntegrity";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-audit-integrity", {
      minute: 5,
      day: 100,
    });
    return NextResponse.json({ integrity: await verifyAdminAuditIntegrity() });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin audit integrity verification failed:", error);
    return NextResponse.json({ error: "Audit integrity verification failed." }, { status: 500 });
  }
}
